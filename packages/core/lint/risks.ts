/**
 * Plan Lint Rule Engine
 *
 * Pure analysis — no I/O. Each checker is `(input) => Risk[]`.
 * Adding a new rule = add a checker + add it to `analyzeImpl`.
 *
 * I/O collectors live in `collectors.ts`. Loop overlays its own
 * progress data on top of what the planner-side collector produces.
 */

import { ok, type Result } from "../result";
import type { Risk } from "./schemas";

// ── Types ────────────────────────────────────────────────────────────

/** Subtask input for risk analysis. */
export interface SubtaskInput {
	id: string;
	shortId?: string | null;
	title: string;
	description?: string | null;
	/**
	 * True if this entry is the parent issue itself, not a child. The parent
	 * is included for rules that judge plan-level quality (vague_description,
	 * etc.) but excluded from rules about sibling parallelism (file_overlap,
	 * unreviewable_scope) — the parent isn't a dispatch unit.
	 */
	isParent?: boolean;
}

/**
 * Minimal reopen-event shape for thrash detection. Compatible with loop's
 * `ProgressEntry` so loop can pass its entries directly without conversion.
 */
export interface ReopenEvent {
	subtaskId: string;
	status: "completed" | "failed" | "reopened" | string;
}

/** Options for the full analysis. */
export interface AnalyzeOptions {
	/** Parent issue + its subtasks. Pass the parent first (or omit if not analyzing it). */
	subtasks: SubtaskInput[];
	/** Reopen events from loop progress history. Empty array if unavailable. */
	progressEntries: ReopenEvent[];
	/** Set of file paths that have co-located .test.ts files */
	existingTestFiles: Set<string>;
	/** Package paths referenced by subtasks (for missing test detection) */
	packagePaths: string[];
}

// ── File-path extraction ────────────────────────────────────────────

/**
 * Extract file paths mentioned in a text block.
 * Matches patterns like `packages/loop/foo/bar.ts` or `src/index.ts`.
 */
const extractFilePaths = (text: string): string[] => {
	const pattern =
		/(?:^|\s|`|"|')([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,4})(?:\s|`|"|'|$|,|;|\))/g;
	const matches = text.matchAll(pattern);
	const paths: string[] = [];
	for (const match of matches) {
		const candidate = match[1];
		if (candidate.includes("/") && !candidate.startsWith("http")) {
			paths.push(candidate);
		}
	}
	return paths;
};

// ── Individual risk checks (pure) ───────────────────────────────────

/**
 * Detect file overlap: multiple subtasks referencing the same file.
 * High risk if ≥3 subtasks share a file (merge conflicts if run in parallel).
 */
const checkFileOverlapImpl = (subtasks: SubtaskInput[]): Risk[] => {
	const fileToSubtasks = new Map<string, string[]>();

	for (const subtask of subtasks) {
		// Parent isn't a dispatch unit — its PRD-style file list shouldn't
		// count as a "claimant" for overlap purposes.
		if (subtask.isParent) continue;

		const text = [subtask.title, subtask.description ?? ""].join(" ");
		const files = extractFilePaths(text);
		const displayId = subtask.shortId ?? subtask.id.slice(0, 8);

		for (const file of files) {
			const existing = fileToSubtasks.get(file) ?? [];
			if (!existing.includes(displayId)) {
				existing.push(displayId);
			}
			fileToSubtasks.set(file, existing);
		}
	}

	const risks: Risk[] = [];
	for (const [file, ids] of fileToSubtasks) {
		if (ids.length > 1) {
			risks.push({
				type: "file_overlap",
				severity: ids.length >= 3 ? "high" : "medium",
				message: `${file} referenced by ${ids.join(", ")} — potential merge conflict if run in parallel`,
			});
		}
	}

	return risks;
};

/**
 * Detect missing test files for packages referenced by subtasks.
 * Flags when a package directory has no .test.ts files at all
 * (JAKE-228: empty test dirs return non-zero from `bun test`).
 */
const checkMissingTestsImpl = (
	packagePaths: string[],
	existingTestFiles: Set<string>,
): Risk[] => {
	const risks: Risk[] = [];

	for (const pkg of packagePaths) {
		const hasTests = [...existingTestFiles].some((f) => f.startsWith(pkg));
		if (!hasTests) {
			risks.push({
				type: "no_tests",
				severity: "medium",
				message: `No test files found in ${pkg} — bun test may return non-zero (JAKE-228)`,
			});
		}
	}

	return risks;
};

/**
 * Flag large subtask count as a scope risk.
 * >10 subtasks = medium, >20 = high.
 */
const checkLargeScopeImpl = (subtaskCount: number): Risk[] => {
	if (subtaskCount > 20) {
		return [
			{
				type: "large_scope",
				severity: "high",
				message: `${subtaskCount} subtasks — consider breaking into smaller issues to reduce iteration count`,
			},
		];
	}
	if (subtaskCount > 10) {
		return [
			{
				type: "large_scope",
				severity: "medium",
				message: `${subtaskCount} subtasks — larger scope increases cost and thrash risk`,
			},
		];
	}
	return [];
};

/**
 * Detect past thrash patterns from progress history.
 * Mirrors JAKE-258 pattern.
 */
const checkPastThrashImpl = (entries: ReopenEvent[]): Risk[] => {
	const reopenCounts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.status === "reopened") {
			reopenCounts.set(
				entry.subtaskId,
				(reopenCounts.get(entry.subtaskId) ?? 0) + 1,
			);
		}
	}

	const risks: Risk[] = [];
	for (const [subtaskId, count] of reopenCounts) {
		if (count >= 3) {
			risks.push({
				type: "past_thrash",
				severity: "high",
				message: `${subtaskId} reopened ${count} times — likely thrash loop (JAKE-258 pattern)`,
			});
		} else if (count >= 2) {
			risks.push({
				type: "past_thrash",
				severity: "medium",
				message: `${subtaskId} reopened ${count} times — potential thrash`,
			});
		}
	}

	return risks;
};

/**
 * Flag subtasks with vague descriptions: very short, or zero file paths
 * mentioned (no concrete deliverable surface). Indicates the planner
 * hasn't grounded the work in the codebase.
 */
const checkVagueDescriptionImpl = (subtasks: SubtaskInput[]): Risk[] => {
	const risks: Risk[] = [];

	for (const subtask of subtasks) {
		const description = subtask.description ?? "";
		const displayId = subtask.shortId ?? subtask.id.slice(0, 8);
		const trimmed = description.trim();

		if (trimmed.length === 0) {
			risks.push({
				type: "vague_description",
				severity: "high",
				message: `${displayId} has no description — agents have nothing to ground the work in`,
			});
			continue;
		}

		if (trimmed.length < 50) {
			risks.push({
				type: "vague_description",
				severity: "medium",
				message: `${displayId} description is ${trimmed.length} chars — likely too thin to dispatch`,
			});
			continue;
		}

		const text = [subtask.title, description].join(" ");
		const files = extractFilePaths(text);
		if (files.length === 0) {
			risks.push({
				type: "vague_description",
				severity: "low",
				message: `${displayId} mentions no file paths — consider adding concrete targets`,
			});
		}
	}

	return risks;
};

/**
 * Flag any single subtask that touches more than `threshold` distinct files.
 * Such subtasks are hard to review and often hide multiple concerns.
 */
const checkUnreviewableScopeImpl = (
	subtasks: SubtaskInput[],
	threshold = 8,
): Risk[] => {
	const risks: Risk[] = [];

	for (const subtask of subtasks) {
		// Parent's PRD-style description naturally lists many files; only
		// flag dispatchable subtasks.
		if (subtask.isParent) continue;

		const text = [subtask.title, subtask.description ?? ""].join(" ");
		const files = new Set(extractFilePaths(text));
		const displayId = subtask.shortId ?? subtask.id.slice(0, 8);

		if (files.size > threshold) {
			risks.push({
				type: "unreviewable_scope",
				severity: files.size > threshold * 2 ? "high" : "medium",
				message: `${displayId} references ${files.size} distinct files — consider splitting`,
			});
		}
	}

	return risks;
};

// ── Composite analysis ──────────────────────────────────────────────

const analyzeImpl = (options: AnalyzeOptions): Result<Risk[]> => {
	const risks: Risk[] = [
		...checkFileOverlapImpl(options.subtasks),
		...checkMissingTestsImpl(options.packagePaths, options.existingTestFiles),
		...checkLargeScopeImpl(options.subtasks.length),
		...checkPastThrashImpl(options.progressEntries),
		...checkVagueDescriptionImpl(options.subtasks),
		...checkUnreviewableScopeImpl(options.subtasks),
	];

	const severityOrder: Record<string, number> = {
		high: 0,
		medium: 1,
		low: 2,
	};
	risks.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

	return ok(risks);
};

// ── Public API ──────────────────────────────────────────────────────

export namespace RiskAnalyzer {
	/** Run all lint checks on the given subtasks and history. */
	export const analyze = analyzeImpl;

	/** Check file overlap between subtask descriptions. Pure. */
	export const checkFileOverlap = checkFileOverlapImpl;

	/** Check for missing test files in referenced packages. Pure. */
	export const checkMissingTests = checkMissingTestsImpl;

	/** Check for large subtask scope. Pure. */
	export const checkLargeScope = checkLargeScopeImpl;

	/** Check for past thrash patterns from progress history. Pure. */
	export const checkPastThrash = checkPastThrashImpl;

	/** Check for vague or under-grounded subtask descriptions. Pure. */
	export const checkVagueDescription = checkVagueDescriptionImpl;

	/** Check for subtasks touching too many files to review well. Pure. */
	export const checkUnreviewableScope = checkUnreviewableScopeImpl;
}
