/**
 * Task Entry Schema
 *
 * An issue's timeline is a list of entries: a kind, an author, a time and a
 * markdown body kabane never parses. A comment is an entry of kind `comment`,
 * the default; the comment types below are what the entry types were before
 * kinds, kept for the hosts compiled against them.
 */

import { z } from "zod";

/**
 * Author type - who created the comment
 */
export const AuthorTypeSchema = z.enum(["human", "ai"]);
export type AuthorType = z.infer<typeof AuthorTypeSchema>;

/**
 * Full comment record (stored in database)
 */
export const TaskCommentSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Task this comment belongs to */
	taskId: z.string(),

	/** Author name or agent identifier */
	author: z.string(),

	/** Whether author is human or AI */
	authorType: AuthorTypeSchema,

	/** Comment content (Markdown) */
	content: z.string().min(1),

	/** Creation timestamp */
	createdAt: z.string().datetime(),

	/** Last update timestamp (if edited) */
	updatedAt: z.string().datetime().optional(),
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

/** The kind an entry has when its writer names none. */
export const DEFAULT_ENTRY_KIND = "comment";

/**
 * A kind is a soft string, never a closed list: `name` or `name.key`, lowercase.
 * Any kind of this shape is stored, declared by a module or not.
 */
export const ENTRY_KIND_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

export const EntryKindNameSchema = z
	.string()
	.regex(
		ENTRY_KIND_PATTERN,
		'a kind is lowercase letters, digits and dashes, as "name" or "name.key" (e.g. "review", "handoff.summary")',
	);

/** One entry on an issue's timeline (stored in `task_comments`). */
export const TaskEntrySchema = TaskCommentSchema.extend({
	kind: EntryKindNameSchema,
});
export type TaskEntry = z.infer<typeof TaskEntrySchema>;

/** Draft for creating an entry: a comment draft with its kind. */
export const TaskEntryDraftSchema = TaskEntrySchema.omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});
export type TaskEntryDraft = z.infer<typeof TaskEntryDraftSchema>;

/**
 * Draft for creating a new comment (without id, timestamps)
 */
export const TaskCommentDraftSchema = TaskCommentSchema.omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});
export type TaskCommentDraft = z.infer<typeof TaskCommentDraftSchema>;

/**
 * Partial update for editing a comment
 */
export const TaskCommentUpdateSchema = z.object({
	/** Updated content */
	content: z.string().min(1),
});
export type TaskCommentUpdate = z.infer<typeof TaskCommentUpdateSchema>;
