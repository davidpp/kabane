// A run's git worktree, and the checkpoints committed in it. On unless the run opts out: `git
// worktree add` on a branch of its own beside the run's files, or the worktree of the parent's
// last run when its work is not merged yet, recorded in run.json. Once its work is merged it is
// removed, with its branch (`Prune`). A checkpoint is a commit of everything in the worktree
// after a green gate; a rollback resets the worktree to one of them.
//
// Nothing here commits into, or resets, the user's own checkout: `checkpoint` and `rollback`
// refuse any directory that is not a linked worktree, so a run without one cannot reach them by
// mistake.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result, trySync } from "@cabane/core";
import { Exec } from "./exec";
import { FileLock } from "./lock";
import type { RunStore } from "./store";

export namespace Worktree {
	/** `git <args>` in `cwd`: its stdout, or an error carrying what git said. */
	export type Git = Exec.Tool;

	/** The user's own git. */
	export const git: Git = Exec.tool("git");

	const lockFile = (dir: string): string => `${dir}.lock`;

	/** What holds the lock on the worktree at `dir`, while it is held. */
	export const lockedBy = (dir: string): string | undefined =>
		FileLock.heldFor(lockFile(dir));

	/**
	 * Take the lock on the worktree at `dir` for `what`, for as long as one thing changes it that
	 * is not a live run (a live run's status already keeps the others out): `<dir>.lock`, a
	 * `FileLock`. Refused while another live process holds it; one a process that is gone left is
	 * taken over. Returns its release.
	 */
	export const lock = (dir: string, what: string): Result<() => void> => {
		const taken = FileLock.take(lockFile(dir), what);
		return taken.ok
			? taken
			: err(new Error(`the worktree ${dir} is ${taken.error.message}`));
	};

	/** Where run `runId`'s worktree goes: inside the run's own directory. */
	export const dirFor = (runDir: string): string => join(runDir, "worktree");

	// Long enough for a few words of the title, short enough to read in a branch list.
	const BRANCH_CHARS = 48;

	/**
	 * The branch a run makes for issue `shortId` titled `title`, named as a person would name it:
	 * `jcab-81-` and the title's first words, lowercase ASCII.
	 */
	export const branchFor = (shortId: string, title: string): string => {
		const words = title
			// Accents come off their letters (é is e) rather than splitting the word.
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w !== "");
		let name = shortId.toLowerCase().replace(/[^a-z0-9-]/g, "");
		for (const word of words) {
			if (name.length + 1 + word.length > BRANCH_CHARS) break;
			name = name === "" ? word : `${name}-${word}`;
		}
		return name === "" ? "kabane-loop" : name;
	};

	// `refs/heads/<name>` and `refs/remotes/<remote>/<name>`, as `<name>`.
	const BRANCH_REF = /^refs\/(?:heads|remotes\/[^/]+)\/(.+)$/;

	/**
	 * `branch`, or the first of `branch-2`, `branch-3`… that names no branch of `projectDir`'s
	 * repository yet, local or on a remote it knows: an earlier run on the same issue, a pull
	 * request closed without merging, keeps its own.
	 */
	export const unused = async (
		projectDir: string,
		branch: string,
		run: Git = git,
	): Promise<Result<string>> => {
		const listed = await run(projectDir, [
			"for-each-ref",
			"--format=%(refname)",
			"refs/heads",
			"refs/remotes",
		]);
		if (!listed.ok) return listed;
		const taken = new Set(
			listed.value.split("\n").flatMap((ref) => {
				const name = BRANCH_REF.exec(ref.trim())?.[1];
				return name ? [name] : [];
			}),
		);
		let name = branch;
		for (let n = 2; taken.has(name); n++) name = `${branch}-${n}`;
		return ok(name);
	};

	/** A worktree of `projectDir`'s HEAD at `dir`, on a new branch `branch`. */
	export const add = async (
		projectDir: string,
		dir: string,
		branch: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const added = await run(projectDir, [
			"worktree",
			"add",
			"-q",
			"-b",
			branch,
			dir,
			"HEAD",
		]);
		return added.ok ? ok(undefined) : added;
	};

	/**
	 * Whether `dir` is in a git repository: a `.git` (a directory, or a linked worktree's file) in
	 * it or above it. Read off the filesystem rather than git's error text, which is localized.
	 */
	export const inRepo = (dir: string): boolean => {
		for (let at = resolve(dir); ; at = dirname(at)) {
			if (existsSync(join(at, ".git"))) return true;
			if (dirname(at) === at) return false;
		}
	};

	const real = (path: string): string | undefined => {
		const found = trySync(() => realpathSync(path));
		return found.ok ? found.value : undefined;
	};

	const BRANCH = "branch refs/heads/";

	/**
	 * The branch checked out in `dir` when it is one of `projectDir`'s repository's worktrees and
	 * still on disk; undefined when it was removed or deleted, or its HEAD is detached.
	 */
	export const branchOf = async (
		projectDir: string,
		dir: string,
		run: Git = git,
	): Promise<Result<string | undefined>> => {
		const wanted = real(dir);
		if (wanted === undefined) return ok(undefined);
		const listed = await run(projectDir, ["worktree", "list", "--porcelain"]);
		if (!listed.ok) return listed;
		for (const entry of listed.value.split("\n\n")) {
			const lines = entry.split("\n");
			const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
			if (path === undefined || real(path) !== wanted) continue;
			return ok(lines.find((l) => l.startsWith(BRANCH))?.slice(BRANCH.length));
		}
		return ok(undefined);
	};

	/** Whether `branch`'s tip is in `projectDir`'s HEAD: merged, or never moved past it. */
	export const merged = async (
		projectDir: string,
		branch: string,
		run: Git = git,
	): Promise<Result<boolean>> => {
		const found = await run(projectDir, [
			"for-each-ref",
			"--merged",
			"HEAD",
			"--format=%(refname)",
			`refs/heads/${branch}`,
		]);
		return found.ok ? ok(found.value.trim() !== "") : found;
	};

	/** A checkout's HEAD: its commit, and its branch unless HEAD is detached. */
	export type Head = { branch?: string; sha: string };

	export const head = async (
		dir: string,
		run: Git = git,
	): Promise<Result<Head>> => {
		const sha = await run(dir, ["rev-parse", "HEAD"]);
		if (!sha.ok) return sha;
		// Exits 1, quietly, on a detached HEAD.
		const branch = await run(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
		const name = branch.ok ? branch.value.trim() : "";
		return ok({ ...(name ? { branch: name } : {}), sha: sha.value.trim() });
	};

	/** Where `dir` sits inside its repository, relative to the top: "" at the top. */
	export const prefixOf = async (
		dir: string,
		run: Git = git,
	): Promise<Result<string>> => {
		const shown = await run(dir, ["rev-parse", "--show-prefix"]);
		return shown.ok ? ok(shown.value.trim().replace(/\/$/, "")) : shown;
	};

	/** Whether `path`, relative to the repository top, is in `dir`'s HEAD. */
	export const has = async (
		dir: string,
		path: string,
		run: Git = git,
	): Promise<boolean> =>
		(await run(dir, ["cat-file", "-e", `HEAD:${path}`])).ok;

	// A linked worktree's git dir is its own, under the main repository's common dir; the main
	// checkout's is the common dir itself.
	const linked = async (dir: string, run: Git): Promise<Result<void>> => {
		const own = await run(dir, [
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
		]);
		if (!own.ok) return own;
		const common = await run(dir, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (!common.ok) return common;
		return own.value.trim() !== common.value.trim()
			? ok(undefined)
			: err(
					new Error(`${dir} is not a linked worktree; refusing to change it`),
				);
	};

	/**
	 * Commit everything in the worktree at `dir` as a checkpoint: its sha, or undefined when there
	 * was nothing to commit. The user's own git config and hooks apply, as to any commit of theirs.
	 */
	export const checkpoint = async (
		dir: string,
		message: string,
		run: Git = git,
	): Promise<Result<string | undefined>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const added = await run(dir, ["add", "-A"]);
		if (!added.ok) return added;
		const staged = await run(dir, ["status", "--porcelain"]);
		if (!staged.ok) return staged;
		if (staged.value.trim() === "") return ok(undefined);
		const committed = await run(dir, ["commit", "-q", "-m", message]);
		if (!committed.ok) return committed;
		const sha = await run(dir, ["rev-parse", "HEAD"]);
		return sha.ok ? ok(sha.value.trim()) : sha;
	};

	const SHA = /^[0-9a-f]{4,40}$/;

	/** The one checkpoint `given` names, as a full sha or a prefix of one. */
	export const match = (
		checkpoints: readonly string[],
		given: string,
	): Result<string> => {
		const wanted = given.trim().toLowerCase();
		const found = SHA.test(wanted)
			? checkpoints.filter((sha) => sha.startsWith(wanted))
			: [];
		if (found.length === 1 && found[0] !== undefined) return ok(found[0]);
		const listed = checkpoints.map((sha) => sha.slice(0, 12)).join(", ");
		return err(
			new Error(
				found.length > 1
					? `${given} names more than one checkpoint: give more of the sha (${listed})`
					: `${given} is not one of this run's checkpoints${listed ? `: ${listed}` : "; it has none"}`,
			),
		);
	};

	/**
	 * Reset the worktree at `dir` to checkpoint `sha`: tracked files to the commit, and untracked
	 * ones it did not have removed (ignored files are left alone).
	 */
	export const reset = async (
		dir: string,
		sha: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const reset = await run(dir, ["reset", "-q", "--hard", sha]);
		if (!reset.ok) return reset;
		const cleaned = await run(dir, ["clean", "-q", "-fd"]);
		return cleaned.ok ? ok(undefined) : cleaned;
	};

	// The files a merge or rebase left conflicted in `dir`.
	const conflicted = async (dir: string, run: Git): Promise<string[]> => {
		const listed = await run(dir, ["diff", "--name-only", "--diff-filter=U"]);
		return listed.ok
			? listed.value.split("\n").filter((f) => f.trim() !== "")
			: [];
	};

	/**
	 * Rebase the worktree at `dir` onto commit `onto`. A rebase that stops on a conflict is
	 * aborted, so the branch is left as it was, and the error names the files that conflicted.
	 */
	export const rebase = async (
		dir: string,
		onto: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const rebased = await run(dir, ["rebase", "-q", onto]);
		if (rebased.ok) return ok(undefined);
		const files = await conflicted(dir, run);
		await run(dir, ["rebase", "--abort"]);
		return err(
			files.length > 0
				? new Error(`conflicts in ${files.join(", ")}`)
				: rebased.error,
		);
	};

	/**
	 * Merge `branch` into the worktree at `dir`, as a merge commit of `message` even when it could
	 * fast-forward: the commit it leaves HEAD at. A merge that stops on a conflict is aborted, so
	 * HEAD is left as it was, and the error names the files that conflicted.
	 */
	export const merge = async (
		dir: string,
		branch: string,
		message: string,
		run: Git = git,
	): Promise<Result<string>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const merged = await run(dir, [
			"merge",
			"-q",
			"--no-ff",
			"-m",
			message,
			branch,
		]);
		if (!merged.ok) {
			const files = await conflicted(dir, run);
			// Fails, harmlessly, when the merge never started.
			await run(dir, ["merge", "--abort"]);
			return err(
				files.length > 0
					? new Error(`conflicts in ${files.join(", ")}`)
					: merged.error,
			);
		}
		const sha = await run(dir, ["rev-parse", "HEAD"]);
		return sha.ok ? ok(sha.value.trim()) : sha;
	};

	/**
	 * Merge commit `sha` into the worktree at `dir` and leave a conflict for whoever works there
	 * next to resolve: the files left conflicted, none when it merged cleanly.
	 */
	export const mergeKeepingConflicts = async (
		dir: string,
		sha: string,
		run: Git = git,
	): Promise<Result<string[]>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const merged = await run(dir, ["merge", "-q", "--no-edit", sha]);
		if (merged.ok) return ok([]);
		const files = await conflicted(dir, run);
		return files.length > 0 ? ok(files) : merged;
	};

	/**
	 * Put the worktree at `dir` on a new branch `branch` at commit `sha`, its changes discarded and
	 * the untracked files `sha` does not have removed; what git ignores (build output) stays.
	 */
	export const switchTo = async (
		dir: string,
		branch: string,
		sha: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		// Fails, harmlessly, when no merge is in progress.
		await run(dir, ["merge", "--abort"]);
		const switched = await run(dir, [
			"checkout",
			"-q",
			"-f",
			"-b",
			branch,
			sha,
		]);
		if (!switched.ok) return switched;
		const cleaned = await run(dir, ["clean", "-q", "-fd"]);
		return cleaned.ok ? ok(undefined) : cleaned;
	};

	/**
	 * Take the worktree at `dir` off its branch `branch`, which is merged into `into`'s HEAD, and
	 * delete that branch: the worktree stays, its HEAD detached, for the next branch.
	 */
	export const detach = async (
		dir: string,
		branch: string,
		into: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const detached = await run(dir, ["checkout", "-q", "--detach"]);
		if (!detached.ok) return detached;
		const deleted = await run(into, ["branch", "-q", "-d", branch]);
		return deleted.ok ? ok(undefined) : deleted;
	};

	/**
	 * Put the worktree at `dir` back on `branch` at commit `tip`: a rebase left stopped is
	 * aborted, the branch checked out again, and reset there as `reset` resets.
	 */
	export const restore = async (
		dir: string,
		branch: string,
		tip: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		// Fails, harmlessly, when no rebase is in progress.
		await run(dir, ["rebase", "--abort"]);
		const back = await run(dir, ["checkout", "-q", "-f", branch]);
		return back.ok ? reset(dir, tip, run) : back;
	};

	/**
	 * Remove the worktree at `dir`, one of `projectDir`'s repository's, leaving its branch: refused
	 * while it has changes not committed or files git does not ignore.
	 */
	export const drop = async (
		projectDir: string,
		dir: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const removed = await run(projectDir, ["worktree", "remove", dir]);
		return removed.ok ? ok(undefined) : removed;
	};

	/**
	 * Remove the worktree at `dir` and delete its branch: a run's worktree whose work is merged.
	 * `git worktree remove` refuses a worktree with changes not committed, which is left as it is.
	 * A branch merged into HEAD is deleted as git deletes a merged branch; one `squashed` into the
	 * base by its pull request is not merged as git sees it, and is deleted regardless.
	 */
	export const remove = async (
		projectDir: string,
		dir: string,
		branch: string,
		squashed: boolean,
		run: Git = git,
	): Promise<Result<void>> => {
		const removed = await drop(projectDir, dir, run);
		if (!removed.ok) return removed;
		const deleted = await run(projectDir, [
			"branch",
			"-q",
			squashed ? "-D" : "-d",
			branch,
		]);
		return deleted.ok ? ok(undefined) : deleted;
	};

	/** The trace's line for a rollback. */
	export const rolledBack = (sha: string, by: string): RunStore.EventDraft => ({
		type: "rollback",
		summary: `worktree reset to checkpoint ${sha.slice(0, 12)} by ${by}`,
		data: { sha, by },
	});
}
