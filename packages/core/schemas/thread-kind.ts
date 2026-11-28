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
const DefaultKindWriteSchema = z.enum(["add", "apply"]);
export type DefaultKindWrite = z.infer<typeof DefaultKindWriteSchema>;

export const CodeThreadKindSchema = ThreadKindSchema.extend({
	/** A new thread of the kind starts in this state; without it, with none. */
	initialState: TaskStateSchema.optional(),
	/** A listing that names no kind leaves the kind out. */
	unlisted: z.literal(true).optional(),
	/**
	 * The writes that take this kind when they name none: `add` (one thread)
	 * and `apply` (a plan's threads). One kind holds each; without a holder,
	 * the plain thread.
	 */
	defaultFor: z.array(DefaultKindWriteSchema).min(1).optional(),
}).strict();
export type CodeThreadKind = z.infer<typeof CodeThreadKindSchema>;

/**
 * The kinds core declares: only the plain thread, whose name no module or scope
 * may declare. The shipped work kinds are `@kabane/work`'s (ADR 0012).
 */
export const CORE_THREAD_KINDS: readonly CodeThreadKind[] = [
	{
		name: PLAIN_THREAD_KIND,
		label: "Thread",
		description: "A plain thread: content, attributes, entries and refs.",
	},
];
