import { z } from "zod";
import { Runtime } from "./runtime";
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
/** Canonical core order, then module registration order at each anchor. */
export const registeredContextSections = (): string[] => {
	const sections = Runtime.modules().flatMap(
		(module) => module.contextSections ?? [],
	);
	return CONTEXT_SECTIONS.flatMap((core) => [
		core,
		...sections
			.filter((section) => section.after === core)
			.map((section) => section.name),
	]);
};

export const ContextPageOptionsSchema = AssembleContextOptsSchema.extend({
	sections: z
		.array(z.string())
		.max(100)
		.superRefine((sections, ctx) => {
			const valid = registeredContextSections();
			const unknown = sections.filter((section) => !valid.includes(section));
			if (unknown.length)
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Valid sections: ${valid.join(", ")}. Unknown sections (excerpt): ${unknown.join(", ").slice(0, 80)}`,
				});
		})
		.default(registeredContextSections),
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
				completedSections: z.array(z.string()),
				remainingSections: z.array(z.string()),
				omittedSections: z.array(z.string()),
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
