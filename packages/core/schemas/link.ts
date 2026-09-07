/**
 * Task Link Schema
 *
 * Flexible relationships between tasks (parent/child, blockers, related).
 * Stored in separate table for N:N relationships.
 */

import { z } from "zod";

/**
 * Link relationship types
 */
export const LinkTypeSchema = z.enum([
	"parent", // Source is parent of target (subtask relationship)
	"child", // Source is child of target (inverse of parent)
	"blocks", // Source blocks target (must complete source first)
	"blocked_by", // Source is blocked by target
	"related", // Informational relationship
	"duplicate", // Source duplicates target
	"follows", // Source should be done after target
]);
export type LinkType = z.infer<typeof LinkTypeSchema>;

/**
 * Task link record (stored in database)
 */
export const TaskLinkSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Source task ID */
	sourceId: z.string(),

	/** Target task ID */
	targetId: z.string(),

	/** Relationship type */
	type: LinkTypeSchema,

	/** Optional note explaining the relationship */
	note: z.string().optional(),

	/** Creation timestamp */
	createdAt: z.string().datetime(),
});
export type TaskLink = z.infer<typeof TaskLinkSchema>;

/**
 * Draft for creating a link (without id, timestamp)
 */
export const TaskLinkDraftSchema = TaskLinkSchema.omit({
	id: true,
	createdAt: true,
});
export type TaskLinkDraft = z.infer<typeof TaskLinkDraftSchema>;

/**
 * Embedded link reference (for task responses)
 * Lighter weight than full TaskLink - just the relationship info
 */
export const EmbeddedLinkSchema = z.object({
	/** Relationship type */
	type: LinkTypeSchema,

	/** The other task's ID */
	taskId: z.string(),

	/** Optional note */
	note: z.string().optional(),
});
export type EmbeddedLink = z.infer<typeof EmbeddedLinkSchema>;
