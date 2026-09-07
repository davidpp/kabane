/**
 * Plan Lint Schemas
 *
 * Shared types for plan quality checks. Used by:
 * - `jake plan lint <id>` CLI
 * - `planner.lint` tRPC procedure
 * - Loop briefing (pre-dispatch risk display)
 */

import { z } from "zod";

/**
 * Lint rule type — extended as new rules are added.
 *
 * Adding a new rule: extend this enum + add a checker in `risks.ts`.
 */
export const RiskTypeSchema = z.enum([
	"file_overlap",
	"no_tests",
	"large_scope",
	"past_thrash",
	"vague_description",
	"unreviewable_scope",
]);

export type RiskType = z.infer<typeof RiskTypeSchema>;

/**
 * Severity of a lint finding. `--strict` exits non-zero on `high`.
 */
export const RiskSeveritySchema = z.enum(["low", "medium", "high"]);

export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

/**
 * A single lint finding.
 */
export const RiskSchema = z.object({
	type: RiskTypeSchema,
	message: z.string(),
	severity: RiskSeveritySchema,
});

export type Risk = z.infer<typeof RiskSchema>;
