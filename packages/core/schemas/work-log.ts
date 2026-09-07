/**
 * Work Log Schema
 *
 * URI-based references to work accomplished on tasks.
 * Links tasks to sessions, commits, PRs, and other artifacts.
 */

import { z } from "zod";
import { AuthorTypeSchema } from "./comment";

/**
 * URI patterns for work references:
 * - session:<sessionId> - Jake session
 * - commit:<sha> - Git commit
 * - pr:<owner>/<repo>#<number> - Pull request
 * - issue:<owner>/<repo>#<number> - GitHub issue
 * - file:<path> - File reference
 * - url:<https://...> - External URL
 * - branch:<name> - Git branch
 */
export const WorkRefSchema = z.object({
	/** URI reference (e.g., "session:abc123", "commit:f2d406c") */
	uri: z.string().min(1),

	/** Human-readable label */
	label: z.string().optional(),

	/** When this reference was added */
	addedAt: z.string().datetime(),

	/** Who added this reference */
	addedBy: z.string().optional(),

	/** Whether added by human or AI */
	addedByType: AuthorTypeSchema.optional(),
});
export type WorkRef = z.infer<typeof WorkRefSchema>;

/**
 * Full work log entry (stored in database)
 *
 * Groups related work references with optional context.
 */
export const TaskWorkLogSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Task this work log belongs to */
	taskId: z.string(),

	/** Array of URI references */
	refs: z.array(WorkRefSchema).min(1),

	/** Optional context/summary note */
	note: z.string().optional(),

	/** Creation timestamp */
	createdAt: z.string().datetime(),
});
export type TaskWorkLog = z.infer<typeof TaskWorkLogSchema>;

/**
 * Draft for creating a new work log entry
 */
export const TaskWorkLogDraftSchema = TaskWorkLogSchema.omit({
	id: true,
	createdAt: true,
});
export type TaskWorkLogDraft = z.infer<typeof TaskWorkLogDraftSchema>;

/**
 * Simplified input for adding a work log entry
 * (refs will be constructed from individual fields)
 */
export const AddWorkLogInputSchema = z.object({
	/** Task to add work log to */
	taskId: z.string(),

	/** Work references to add */
	refs: z
		.array(
			z.object({
				uri: z.string().min(1),
				label: z.string().optional(),
			}),
		)
		.min(1),

	/** Optional context note */
	note: z.string().optional(),

	/** Who is adding this (defaults to 'human') */
	addedBy: z.string().optional(),

	/** Whether added by human or AI (defaults to 'human') */
	addedByType: AuthorTypeSchema.optional(),
});
export type AddWorkLogInput = z.infer<typeof AddWorkLogInputSchema>;

/**
 * Parse a URI into type and value
 */
export function parseWorkRefUri(
	uri: string,
): { type: string; value: string } | null {
	const colonIndex = uri.indexOf(":");
	if (colonIndex === -1) return null;

	const type = uri.slice(0, colonIndex);
	const value = uri.slice(colonIndex + 1);

	return { type, value };
}

/**
 * Supported URI types for work references
 */
export const WORK_REF_TYPES = [
	"session", // Jake session
	"commit", // Git commit
	"pr", // Pull request
	"issue", // GitHub issue
	"file", // File reference
	"url", // External URL
	"branch", // Git branch
	"obsidian", // Obsidian vault note
] as const;
export type WorkRefType = (typeof WORK_REF_TYPES)[number];
