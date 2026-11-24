/**
 * A plan file (ADR 0006, "A plan is filed as one file"): threads with the keys
 * a planner chose in place of ids, and the links between them. Applied under
 * a plan key, each thread's id is `<plan key>/<thread key>`, so applying the
 * same plan again lands on the same threads and creates nothing.
 */

import { z } from "zod";
import { LinkTypeSchema } from "./link";
import { ItemKindSchema, TaskPrioritySchema, TaskStateSchema } from "./task";

/** A key a planner chooses: a plan's, or a thread's within its plan. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A thread id taken from keys, `<plan key>/<thread key>`. No label or ULID
 * holds a slash, so neither is ever read as one.
 */
export const KEYED_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

const KeySchema = z
	.string()
	.regex(
		KEY_PATTERN,
		"use lowercase letters, digits, dots, dashes and underscores",
	);

/** A thread end: a key in the same plan, or an existing task's id or label. */
const EndSchema = z.string().min(1);

export const PlanThreadSchema = z
	.object({
		key: KeySchema,
		title: z.string().min(1).max(500),
		kind: ItemKindSchema.optional(),
		description: z.string().optional(),
		state: TaskStateSchema.optional(),
		priority: TaskPrioritySchema.optional(),
		assignee: z.string().optional(),
		tags: z.array(z.string()).optional(),
		scopeUri: z.string().optional(),
		parent: EndSchema.optional(),
	})
	.strict();

export const PlanLinkSchema = z
	.object({
		from: EndSchema,
		to: EndSchema,
		type: LinkTypeSchema,
		note: z.string().optional(),
	})
	.strict();

export const PlanSchema = z
	.object({
		threads: z.array(PlanThreadSchema).min(1),
		links: z.array(PlanLinkSchema).default([]),
	})
	.strict()
	.superRefine((plan, ctx) => {
		const keys = plan.threads.map((thread) => thread.key);
		const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
		if (repeated !== undefined)
			ctx.addIssue({
				code: "custom",
				message: `Thread key "${repeated}" is used twice; each thread needs its own.`,
			});
	});
export type Plan = z.input<typeof PlanSchema>;

export { KeySchema as PlanKeySchema };
