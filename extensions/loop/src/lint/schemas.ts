/**
 * Plan Lint Schemas
 *
 * Shared types for plan quality checks, used by the loop's briefing
 * (pre-dispatch risk display).
 */

import { z } from "zod";

/**
 * Lint rule type — extended as new rules are added.
 *
 * Adding a new rule: extend this enum + add a checker in `risks.ts`.
 */
const RiskTypeSchema = z.enum([
	"file_overlap",
	"no_tests",
	"large_scope",
	"past_thrash",
	"vague_description",
	"unreviewable_scope",
]);

/**
 * Severity of a lint finding. `--strict` exits non-zero on `high`.
 */
const RiskSeveritySchema = z.enum(["low", "medium", "high"]);

export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

/**
 * A single lint finding.
 */
const RiskSchema = z.object({
	type: RiskTypeSchema,
	message: z.string(),
	severity: RiskSeveritySchema,
});

export type Risk = z.infer<typeof RiskSchema>;
