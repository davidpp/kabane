import { z } from "zod";
import { type KabaneModule, Modules } from "./module";
import { Runtime } from "./runtime";
import {
	AssembleContextOptsSchema,
	CONTEXT_SECTIONS,
} from "./schemas/assemble-context";

export const CONTEXT_BYTES = 16 * 1024;
export {
	CONTEXT_SECTIONS,
	ContextSectionSchema,
	type ContextSection,
} from "./schemas/assemble-context";
/**
 * The brief's section names for `modules`: core's canonical order, then at each anchor
 * the modules in the order given, a module's own sections before the `<kind>.latest`
 * sections its kinds project. A host that has not configured the runtime yet (a CLI's
 * help) passes the modules it will register.
 */
export const contextSectionsOf = (
	modules: readonly KabaneModule[],
): string[] => {
	const sections = modules.flatMap((module) => [
		...(module.contextSections ?? []),
		...Modules.latestSections(module),
	]);
	return CONTEXT_SECTIONS.flatMap((core) => [
		core,
		...sections
			.filter((section) => section.after === core)
			.map((section) => section.name),
	]);
};

/** The section names of the brief the registered modules make. */
export const registeredContextSections = (): string[] =>
	contextSectionsOf(Runtime.modules());

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
				/**
				 * The Discussion, and every `<kind>.latest` section whose newest entry
				 * a human wrote, consumed; false while any of them is omitted.
				 */
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
