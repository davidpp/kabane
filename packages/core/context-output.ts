import { z } from "zod";
import { AssembleContextOptsSchema } from "./schemas/assemble-context";

export const CONTEXT_BYTES = 16 * 1024;
export const CONTEXT_SECTIONS = [
	"metadata",
	"description",
	"upstream",
	"position",
	"context",
	"priorWork",
	"discussion",
] as const;
export const ContextSectionSchema = z.enum(CONTEXT_SECTIONS);
export type ContextSection = z.infer<typeof ContextSectionSchema>;
export const ContextPageOptionsSchema = AssembleContextOptsSchema.extend({
	sections: z
		.array(ContextSectionSchema)
		.max(100)
		.default([...CONTEXT_SECTIONS]),
	cursor: z.string().min(1).max(700).optional(),
});
export type ContextPageOptions = z.input<typeof ContextPageOptionsSchema>;
export const ContextPageSchema = z
	.object({
		/** Coverage from offset zero, assuming every preceding chunk was consumed. */
		completeness: z
			.object({
				selectedComplete: z.boolean(),
				descriptionComplete: z.boolean(),
				humanSteeringComplete: z.boolean(),
				completedSections: z.array(ContextSectionSchema),
				remainingSections: z.array(ContextSectionSchema),
				omittedSections: z.array(ContextSectionSchema),
			})
			.strict(),
		taskId: z.string(),
		revision: z.string(),
		/** UTF-16 offset; chunk boundaries never split a Unicode code point. */
		offset: z.number().int().nonnegative(),
		markdown: z.string(),
		nextCursor: z.string().optional(),
		retrieval: z.string(),
	})
	.strict();
export type ContextPage = z.infer<typeof ContextPageSchema>;
