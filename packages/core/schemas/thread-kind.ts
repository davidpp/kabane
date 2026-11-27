/**
 * A thread kind's declaration (ADR 0010): a stable name, the label a reader
 * shows and an optional one-line description. Data only, so core, a module
 * and a scope's published vocabulary declare kinds the same way. A thread
 * whose kind no declaration covers reads with its stored name.
 */

import { z } from "zod";
import { EntryKindNameSchema } from "./comment";
import type { WorkflowKind } from "./task";

export const ThreadKindSchema = z
	.object({
		name: EntryKindNameSchema,
		label: z.string().min(1).max(100),
		description: z.string().min(1).max(500).optional(),
	})
	.strict();
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

/** The kind of a thread with no workflow of its own: no work state is required. */
export const PLAIN_THREAD_KIND = "thread";

/**
 * The kinds core declares. Their names are reserved: no module or scope may
 * declare one. `module.test.ts` holds that every `WORKFLOW_KINDS` entry is declared here.
 */
export const CORE_THREAD_KINDS = [
	{
		name: PLAIN_THREAD_KIND,
		label: "Thread",
		description: "A plain thread: content, attributes, entries and refs.",
	},
	{
		name: "task",
		label: "Task",
		description: "Personal work: inbox, next, done.",
	},
	{
		name: "issue",
		label: "Issue",
		description: "Work an agent runtime picks up.",
	},
	{
		name: "job",
		label: "Job",
		description: "A standing request a schedule runs.",
	},
] as const satisfies readonly (ThreadKind & {
	name: WorkflowKind | typeof PLAIN_THREAD_KIND;
})[];
