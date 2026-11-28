/**
 * A thread kind's declaration (ADR 0010): a stable name, the label a reader
 * shows and an optional one-line description. Data only, so core, a module
 * and a scope's published vocabulary declare kinds the same way. A thread
 * whose kind no declaration covers reads with its stored name.
 */

import { z } from "zod";
import { EntryKindNameSchema } from "./comment";
import { TaskStateSchema } from "./task";

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
 * A kind declared in code, by core or a registered module: its identity plus
 * what the generic record paths do with its threads, so they read data instead
 * of naming kinds. A scope's declaration replicates and stays identity only
 * (`ThreadKindSchema`).
 */
export const CodeThreadKindSchema = ThreadKindSchema.extend({
	/** A new thread of the kind starts in this state; without it, with none. */
	initialState: TaskStateSchema.optional(),
	/** A listing that names no kind leaves the kind out. */
	unlisted: z.literal(true).optional(),
}).strict();
export type CodeThreadKind = z.infer<typeof CodeThreadKindSchema>;

/** A declaration's identity, what discovery shows of it. */
export const threadKindIdentity = ({
	name,
	label,
	description,
}: ThreadKind): ThreadKind =>
	description === undefined ? { name, label } : { name, label, description };

/** The kinds core declares. Their names are reserved: no module or scope may declare one. */
export const CORE_THREAD_KINDS: readonly CodeThreadKind[] = [
	{
		name: PLAIN_THREAD_KIND,
		label: "Thread",
		description: "A plain thread: content, attributes, entries and refs.",
	},
	{
		name: "task",
		label: "Task",
		description: "Personal work: inbox, next, done.",
		initialState: "inbox",
	},
	{
		name: "issue",
		label: "Issue",
		description: "Work an agent runtime picks up.",
		initialState: "inbox",
	},
	{
		// A standing request a schedule runs, not work to pick up. Its schedule and
		// runs belong to the jobs extension.
		name: "job",
		label: "Job",
		description: "A standing request a schedule runs.",
		initialState: "inbox",
		unlisted: true,
	},
];
