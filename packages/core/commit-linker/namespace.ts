/**
 * Commit Linker Namespace
 *
 * Scans git commits for task IDs and links them to planner issues.
 * Follows Linear/GitHub model: developer puts task ID in commit message.
 */

import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import { Planner } from "../storage";
import { hasCloseKeyword, parseAllTaskIds } from "./patterns";

/**
 * Git commit information
 */
export interface GitCommit {
	sha: string;
	message: string;
	author: string;
	authorEmail: string;
	date: string;
}

/**
 * Result of scanning and linking commits
 */
export interface ScanResult {
	scanned: number;
	linked: number;
	closed: number;
	errors: string[];
}

/**
 * Get recent commits from git repository
 */
async function getGitCommits(
	projectPath: string,
	opts: { since?: string; limit?: number },
): Promise<Result<GitCommit[]>> {
	try {
		const limit = opts.limit ?? 100;
		const sinceArg = opts.since
			? `--since="${opts.since}"`
			: '--since="24 hours ago"';

		const proc = Bun.spawn(
			["git", "log", sinceArg, `-n${limit}`, "--format=%H|%s|%an|%ae|%aI"],
			{ cwd: projectPath, stdout: "pipe", stderr: "pipe" },
		);

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		if (stderr && !stdout) {
			return err(new Error(`Git log failed: ${stderr}`));
		}

		const commits: GitCommit[] = [];
		const lines = stdout.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			const [sha, message, author, authorEmail, date] = line.split("|");
			if (sha && message) {
				commits.push({
					sha: sha.trim(),
					message: message.trim(),
					author: author?.trim() ?? "unknown",
					authorEmail: authorEmail?.trim() ?? "",
					date: date?.trim() ?? new Date().toISOString(),
				});
			}
		}

		return ok(commits);
	} catch (e) {
		return err(new Error(`Failed to get git commits: ${e}`));
	}
}

/**
 * Get full commit message (including body) for a commit
 */
async function getFullCommitMessage(
	projectPath: string,
	sha: string,
): Promise<Result<string>> {
	try {
		const proc = Bun.spawn(["git", "log", "-1", "--format=%B", sha], {
			cwd: projectPath,
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = await new Response(proc.stdout).text();
		return ok(stdout.trim());
	} catch (e) {
		return err(new Error(`Failed to get commit message: ${e}`));
	}
}

export namespace CommitLinker {
	/**
	 * Scan recent commits for task IDs and link them to planner issues.
	 *
	 * @param basePath - Jake home path
	 * @param projectPath - Git repository path
	 * @param opts.since - ISO date to start scanning from (default: 24 hours ago)
	 * @param opts.limit - Max commits to scan (default: 100)
	 */
	export const scanAndLink = traced(
		"commit-linker.scan",
		async (
			basePath: string,
			projectPath: string,
			opts: { since?: string; limit?: number } = {},
		): Promise<Result<ScanResult>> => {
			const result: ScanResult = {
				scanned: 0,
				linked: 0,
				closed: 0,
				errors: [],
			};

			// Get recent commits
			const commitsResult = await getGitCommits(projectPath, opts);
			if (!commitsResult.ok) return commitsResult;

			const commits = commitsResult.value;
			result.scanned = commits.length;

			// Initialize planner
			const initResult = await Planner.init(basePath);
			if (!initResult.ok) {
				return err(
					new Error(`Failed to init planner: ${initResult.error.message}`),
				);
			}

			// Process each commit
			for (const commit of commits) {
				// Get full commit message (includes body)
				const fullMessageResult = await getFullCommitMessage(
					projectPath,
					commit.sha,
				);
				const fullMessage = fullMessageResult.ok
					? fullMessageResult.value
					: commit.message;

				// Parse task IDs from commit message
				const taskIds = parseAllTaskIds(fullMessage);

				for (const taskIdStr of taskIds) {
					try {
						// Resolve short ID to full ULID
						const resolveResult = await Planner.resolveTaskId(
							basePath,
							taskIdStr,
						);
						if (!resolveResult.ok) {
							// Task doesn't exist, skip
							continue;
						}
						const taskId = resolveResult.value;

						// Check if already linked via work log
						const workLogsResult = await Planner.getWorkLogs(basePath, taskId);
						if (!workLogsResult.ok) {
							result.errors.push(
								`Failed to get work logs for ${taskIdStr}: ${workLogsResult.error.message}`,
							);
							continue;
						}

						const commitUri = `commit:${commit.sha}`;
						const alreadyLinked = workLogsResult.value.some((log) =>
							log.refs.some((r) => r.uri === commitUri),
						);

						if (!alreadyLinked) {
							// Add work log entry
							const addResult = await Planner.addWorkLog(basePath, {
								taskId,
								refs: [{ uri: commitUri, label: commit.message.slice(0, 80) }],
								note: `Commit by ${commit.author}`,
								addedBy: "commit-linker",
								addedByType: "ai",
							});

							if (addResult.ok) {
								result.linked++;
							} else {
								result.errors.push(
									`Failed to link commit ${commit.sha} to ${taskIdStr}: ${addResult.error.message}`,
								);
							}

							// Check for "closes" keyword - transition to done
							if (hasCloseKeyword(fullMessage, taskIdStr)) {
								const taskResult = await Planner.getTask(basePath, taskId);
								if (
									taskResult.ok &&
									taskResult.value &&
									taskResult.value.state !== "done"
								) {
									const updateResult = await Planner.updateTask(
										basePath,
										taskId,
										{ state: "done" },
									);
									if (updateResult.ok) {
										result.closed++;
									}
								}
							}
						}
					} catch (e) {
						result.errors.push(
							`Error processing ${taskIdStr} in commit ${commit.sha}: ${e}`,
						);
					}
				}
			}

			return ok(result);
		},
	);

	/**
	 * Link a specific commit to a task manually.
	 */
	export const linkCommit = traced(
		"commit-linker.link",
		async (
			basePath: string,
			taskId: string,
			commit: { sha: string; message: string; author?: string },
		): Promise<Result<void>> => {
			// Resolve short ID
			const resolveResult = await Planner.resolveTaskId(basePath, taskId);
			if (!resolveResult.ok) return resolveResult;
			const resolvedId = resolveResult.value;

			const commitUri = `commit:${commit.sha}`;

			// Check if already linked
			const workLogsResult = await Planner.getWorkLogs(basePath, resolvedId);
			if (!workLogsResult.ok) return workLogsResult;

			const alreadyLinked = workLogsResult.value.some((log) =>
				log.refs.some((r) => r.uri === commitUri),
			);

			if (alreadyLinked) {
				return ok(undefined);
			}

			// Add work log
			const addResult = await Planner.addWorkLog(basePath, {
				taskId: resolvedId,
				refs: [{ uri: commitUri, label: commit.message.slice(0, 80) }],
				note: commit.author ? `Commit by ${commit.author}` : undefined,
				addedBy: "commit-linker",
				addedByType: "ai",
			});

			if (!addResult.ok) return addResult;

			return ok(undefined);
		},
	);
}
