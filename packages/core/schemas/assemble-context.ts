/**
 * assembleContext Options Schema
 *
 * Caps and toggles for `Planner.assembleContext` (S3). All fields have
 * house-style defaults; callers pass a partial patch.
 */

import { z } from "zod";

/**
 * Options for `Planner.assembleContext`.
 * - perRefCap: max chars inlined per dereferenced context ref (8KB)
 * - totalRefCap: max chars inlined across all refs before remaining downgrade
 *   to pointers (24KB — same order as comment sizes / MemorySearcher budget)
 * - maxTimelineEntries: cap on Discussion comment entries (20)
 * - includeSubtasks: include the subtask roll-up in Position
 * - deref: inline `file:` refs (vs. always-pointer)
 */
export const AssembleContextOptsSchema = z.object({
	perRefCap: z.number().int().positive().default(8000),
	totalRefCap: z.number().int().positive().default(24000),
	maxTimelineEntries: z.number().int().positive().default(20),
	includeSubtasks: z.boolean().default(true),
	deref: z.boolean().default(true),
});

/** Input (all fields optional — defaults applied). */
export type AssembleContextOpts = z.input<typeof AssembleContextOptsSchema>;
/** Resolved options (all fields present). */
export type ResolvedAssembleContextOpts = z.infer<
	typeof AssembleContextOptsSchema
>;
