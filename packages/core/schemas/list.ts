/**
 * Focus List Schema
 *
 * Two persistent focus buckets for intentional task selection:
 * - daily: "Today's Focus" - what I'm working on today
 * - weekly: "This Week" - what I want to accomplish this week
 *
 * No date tracking - just two named buckets that persist until changed.
 */

import { z } from "zod";

/**
 * Focus period types - two conceptual buckets
 */
export const FocusPeriodSchema = z.enum([
	"daily", // Today's focus
	"weekly", // This week's focus
]);
export type FocusPeriod = z.infer<typeof FocusPeriodSchema>;

/**
 * Focus list item - a task in a focus list with ordering and status
 */
export const FocusItemSchema = z.object({
	/** Task ID */
	taskId: z.string(),

	/** Order in the list (lower = higher priority) */
	order: z.number().nonnegative(),

	/** Completed within this focus period */
	completed: z.boolean().default(false),

	/** When completed (ISO datetime) */
	completedAt: z.string().datetime().optional(),

	/** Notes for this focus session */
	notes: z.string().optional(),
});
export type FocusItem = z.infer<typeof FocusItemSchema>;

/**
 * Focus list record (stored in database)
 */
export const FocusListSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Period type - daily or weekly bucket */
	period: FocusPeriodSchema,

	/** Tasks in this focus list (ordered, must have unique taskIds) */
	items: z
		.array(FocusItemSchema)
		.default([])
		.refine(
			(items) => new Set(items.map((i) => i.taskId)).size === items.length,
			{ message: "Focus list items must have unique taskIds" },
		),

	/** Theme or intention for this focus */
	theme: z.string().optional(),

	/** Reflection notes */
	reflection: z.string().optional(),

	/** Creation timestamp */
	createdAt: z.string().datetime(),

	/** Last update timestamp */
	updatedAt: z.string().datetime(),
});
export type FocusList = z.infer<typeof FocusListSchema>;

/**
 * Draft for creating a focus list
 */
export const FocusListDraftSchema = FocusListSchema.omit({
	id: true,
	createdAt: true,
	updatedAt: true,
});
export type FocusListDraft = z.infer<typeof FocusListDraftSchema>;

/**
 * Update schema for modifying focus list
 */
export const FocusListUpdateSchema = z.object({
	/** Replace items list */
	items: z
		.array(FocusItemSchema)
		.refine(
			(items) => new Set(items.map((i) => i.taskId)).size === items.length,
			{ message: "Focus list items must have unique taskIds" },
		)
		.optional(),

	/** Update theme */
	theme: z.string().optional(),

	/** Update reflection */
	reflection: z.string().optional(),
});
export type FocusListUpdate = z.infer<typeof FocusListUpdateSchema>;
