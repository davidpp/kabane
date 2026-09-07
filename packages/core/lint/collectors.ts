/**
 * Plan Lint Collectors
 *
 * I/O bits — read subtasks from the planner, glob test files from disk,
 * extract package paths from description text.
 *
 * Keep this thin: pure helpers. Stateful operations (loop progress
 * history) are overlaid by callers via `AnalyzeOptions.progressEntries`.
 */

import { ok, type Result, tryCatch } from "../result";
import { Planner } from "../storage";
import type { SubtaskInput } from "./risks";

// ── File-path / package extraction ──────────────────────────────────

const FILE_PATTERN =
	/(?:^|\s|`|"|')([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,4})(?:\s|`|"|'|$|,|;|\))/g;

const extractFilePaths = (text: string): string[] => {
	const paths: string[] = [];
	for (const match of text.matchAll(FILE_PATTERN)) {
		const candidate = match[1];
		if (candidate.includes("/") && !candidate.startsWith("http")) {
			paths.push(candidate);
		}
	}
	return paths;
};

/**
 * Extract distinct package paths referenced across all subtasks.
 *
 * `packages/foo/bar/baz.ts` → `packages/foo`
 * `src/index.ts` → `src` (one-segment "package")
 */
const extractPackagePaths = (subtasks: SubtaskInput[]): string[] => {
	const packages = new Set<string>();
	for (const subtask of subtasks) {
		const text = [subtask.title, subtask.description ?? ""].join(" ");
		for (const file of extractFilePaths(text)) {
			const segments = file.split("/");
			if (segments.length >= 2 && segments[0] === "packages") {
				packages.add(`${segments[0]}/${segments[1]}`);
			} else if (segments.length >= 2) {
				packages.add(segments[0]);
			}
		}
	}
	return [...packages];
};

// ── Test file discovery ─────────────────────────────────────────────

/**
 * Discover existing test files under the given CWD via glob.
 */
const discoverTestFiles = async (cwd: string): Promise<Set<string>> => {
	const result = await tryCatch(async () => {
		const glob = new Bun.Glob("**/*.test.ts");
		const files = new Set<string>();
		for await (const path of glob.scan({ cwd, dot: false })) {
			if (path.includes("node_modules/") || path.includes(".git/")) continue;
			files.add(path);
		}
		return files;
	});
	return result.ok ? result.value : new Set();
};

// ── Composite collector ─────────────────────────────────────────────

export interface CollectOptions {
	/** Path to ~/.jake (or JAKE_HOME) */
	jakePath: string;
	/** Parent task ULID (resolve display IDs upstream via Planner.resolveTaskId) */
	parentTaskId: string;
	/** Working directory for test file discovery */
	cwd?: string;
	/** Include the parent task itself in the subtasks list (default: true) */
	includeParent?: boolean;
}

export interface CollectedInputs {
	subtasks: SubtaskInput[];
	packagePaths: string[];
	existingTestFiles: Set<string>;
	parentTitle: string | null;
	subtaskCount: number;
}

/**
 * Gather all planner-side inputs for the lint engine. Callers overlay
 * extra inputs (loop progress entries, custom package paths) as needed.
 */
const collectImpl = async (
	options: CollectOptions,
): Promise<Result<CollectedInputs>> => {
	const { jakePath, parentTaskId, cwd, includeParent = true } = options;

	const parentResult = await Planner.getTask(jakePath, parentTaskId);
	const parent = parentResult.ok ? parentResult.value : null;

	const subtasksResult = await Planner.queryTasks(jakePath, {
		parentTaskId,
		includeClosed: true,
	});
	const childRows = subtasksResult.ok ? subtasksResult.value : [];

	const subtasks: SubtaskInput[] = [];
	if (includeParent && parent) {
		subtasks.push({
			id: parent.id,
			shortId: parent.shortId,
			title: parent.title,
			description: parent.description,
			isParent: true,
		});
	}
	for (const row of childRows) {
		subtasks.push({
			id: row.id,
			shortId: row.shortId,
			title: row.title,
			description: row.description,
		});
	}

	const packagePaths = extractPackagePaths(subtasks);
	const existingTestFiles = cwd
		? await discoverTestFiles(cwd)
		: new Set<string>();

	return ok({
		subtasks,
		packagePaths,
		existingTestFiles,
		parentTitle: parent?.title ?? null,
		subtaskCount: childRows.length,
	});
};

// ── Public API ──────────────────────────────────────────────────────

export namespace LintCollectors {
	export const collect = collectImpl;
	export const discoverTests = discoverTestFiles;
	export const extractPackages = extractPackagePaths;
}
