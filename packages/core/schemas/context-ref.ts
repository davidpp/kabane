/**
 * Task Context Ref Schema
 *
 * A curated registry of input context refs per task (PRD, ADR, research,
 * transcripts) — the *input* side of an issue, distinct from the append-only
 * work log. `kind` stays a soft string so producers can introduce new kinds
 * without a schema change; CONTEXT_REF_KINDS are suggestions only.
 */

import { z } from "zod";

/**
 * Suggested values for the `kind` field. NOT enforced — kind stays a plain
 * string. Consumers fall back gracefully for unknown kinds
 * (see CONTEXT_KIND_DISPLAY in display.ts).
 */
export const CONTEXT_REF_KINDS = [
	"PRD",
	"ADR",
	"research",
	"exemplar",
	"transcript",
	"design",
	"spec",
	"doc",
] as const;

/**
 * Full context ref record (stored in database).
 */
export const TaskContextRefSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Task this context ref belongs to */
	taskId: z.string(),

	/** URI reference (e.g., "obsidian:prds/foo.md", "comment:<id>") */
	uri: z.string().min(1),

	/** Kind of context (soft string; see CONTEXT_REF_KINDS for suggestions) */
	kind: z.string().min(1),

	/** Human-readable label */
	label: z.string().optional(),

	/** Optional note/context */
	note: z.string().optional(),

	/** Who added this ref */
	addedBy: z.string().optional(),

	/** Whether added by human or AI */
	addedByType: z.enum(["human", "ai"]).optional(),

	/** When this ref was added (ISO timestamp) */
	addedAt: z.string(),
});
export type TaskContextRef = z.infer<typeof TaskContextRefSchema>;

/**
 * Input for adding a context ref (id + addedAt assigned by storage).
 */
export const AddContextRefInputSchema = TaskContextRefSchema.omit({
	id: true,
	addedAt: true,
});
export type AddContextRefInput = z.infer<typeof AddContextRefInputSchema>;
