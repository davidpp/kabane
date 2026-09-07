/**
 * Task Comment Schema
 *
 * Editable comments on tasks for human-facing discussions and context.
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
