/**
 * Plan Lint Namespace
 *
 * One-shot composition: collect inputs from the planner, run all
 * rules, return findings. Used by:
 * - `jake plan lint <id>` CLI
 * - `planner.lint` tRPC procedure
 * - Loop briefing (which overlays its own progress entries)
 */

import { traced } from "../observability";
import { ok, type Result } from "../result";
import { type CollectOptions, LintCollectors } from "./collectors";
import { type ReopenEvent, RiskAnalyzer } from "./risks";
import type { Risk, RiskSeverity } from "./schemas";

// ── Composite lint ──────────────────────────────────────────────────

export interface LintOptions extends CollectOptions {
	/**
	 * Optional reopen events overlaid on top of planner-collected inputs.
	 * Used by loop to feed its progress history into the past_thrash check.
	 */
	progressEntries?: ReopenEvent[];
}

export interface LintResult {
	risks: Risk[];
	parentTitle: string | null;
	subtaskCount: number;
	counts: Record<RiskSeverity, number>;
}

const lintImpl = async (options: LintOptions): Promise<Result<LintResult>> => {
	const collectResult = await LintCollectors.collect(options);
	if (!collectResult.ok) return collectResult;

	const inputs = collectResult.value;

	const analyzeResult = RiskAnalyzer.analyze({
		subtasks: inputs.subtasks,
		packagePaths: inputs.packagePaths,
		existingTestFiles: inputs.existingTestFiles,
		progressEntries: options.progressEntries ?? [],
	});
	if (!analyzeResult.ok) return analyzeResult;

	const risks = analyzeResult.value;
	const counts: Record<RiskSeverity, number> = {
		high: 0,
		medium: 0,
		low: 0,
	};
	for (const risk of risks) {
		counts[risk.severity]++;
	}

	return ok({
		risks,
		parentTitle: inputs.parentTitle,
		subtaskCount: inputs.subtaskCount,
		counts,
	});
};

// ── Public API ──────────────────────────────────────────────────────

export namespace Lint {
	/**
	 * Lint a parent task + its subtasks. Returns all findings sorted by severity.
	 */
	export const run = traced("planner.lint.run", lintImpl, {
		attrs: (options) => ({
			"planner.lint.parentTaskId": options.parentTaskId,
		}),
		resultAttrs: (result) => ({
			"planner.lint.riskCount": result.risks.length,
			"planner.lint.highCount": result.counts.high,
			"planner.lint.mediumCount": result.counts.medium,
			"planner.lint.lowCount": result.counts.low,
		}),
	});
}
