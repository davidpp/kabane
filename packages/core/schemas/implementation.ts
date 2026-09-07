/**
 * Private implementation views
 *
 * A composed, local read over one Jake implementation root and its cached
 * upstream relationships. Provider payloads stay behind the upstream-link
 * allowlist; this schema never carries credentials or arbitrary metadata.
 */

import { z } from "zod";
import { TaskSchema } from "./task";
import { UpstreamLinkSchema } from "./upstream-link";

/**
 * Exactly one lookup shape: a Jake task or an upstream provider reference.
 * This stays one object schema so MCP advertises all three possible fields;
 * the refinement enforces the two strict shapes at runtime.
 */
export const ImplementationSelectorSchema = z
	.object({
		taskId: z.string().min(1).optional(),
		provider: z.string().trim().min(1).optional(),
		externalId: z.string().trim().min(1).optional(),
	})
	.strict()
	.superRefine((selector, ctx) => {
		const isTaskSelector =
			selector.taskId !== undefined &&
			selector.provider === undefined &&
			selector.externalId === undefined;
		const isExternalSelector =
			selector.taskId === undefined &&
			selector.provider !== undefined &&
			selector.externalId !== undefined;
		if (!isTaskSelector && !isExternalSelector) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"Select exactly one shape: { taskId } or { provider, externalId }",
			});
		}
	});
export type ImplementationSelector = z.infer<
	typeof ImplementationSelectorSchema
>;

export const ImplementationRollupSchema = z
	.object({
		total: z.number().int().nonnegative(),
		done: z.number().int().nonnegative(),
		active: z.number().int().nonnegative(),
		needsInput: z.number().int().nonnegative(),
	})
	.strict();
export type ImplementationRollup = z.infer<typeof ImplementationRollupSchema>;

export const ImplementationViewSchema = z
	.object({
		rootTask: TaskSchema,
		upstreamLinks: z.array(UpstreamLinkSchema),
		subtasks: z.array(TaskSchema),
		rollup: ImplementationRollupSchema,
	})
	.strict();
export type ImplementationView = z.infer<typeof ImplementationViewSchema>;

export const ImplementationResultSchema = z
	.object({ implementations: z.array(ImplementationViewSchema) })
	.strict();
export type ImplementationResult = z.infer<typeof ImplementationResultSchema>;
