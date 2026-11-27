/**
 * A thread kind's declaration (ADR 0010): a stable name, the label a reader
 * shows and an optional one-line description. Data only, so core, a module
 * and a scope's published vocabulary declare kinds the same way. A thread
 * whose kind no declaration covers reads with its stored name.
 */

import { z } from "zod";
import { EntryKindNameSchema } from "./comment";
import type { TaskState } from "./task";

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
 * What the generic record paths do with a thread of a core kind, kept on its
 * declaration so they read data instead of naming kinds. Code-only: a module
 * or a scope declares a kind's identity, never these, so they hold on a device
 * or the hub without the kind's extension (a job stays out of every work
 * queue where the jobs extension is off).
 */
type CoreThreadKind = ThreadKind & {
	/** A new thread of the kind starts in this state; without it, with none. */
	initialState?: TaskState;
	/** A listing that names no kind leaves the kind out. */
	unlisted?: true;
};

/** The kinds core declares. Their names are reserved: no module or scope may declare one. */
export const CORE_THREAD_KINDS: readonly CoreThreadKind[] = [
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

/** The state a new thread of `kind` starts in: its declaration's, else none. */
export const initialStateOf = (kind: string): TaskState | undefined =>
	CORE_THREAD_KINDS.find((declared) => declared.name === kind)?.initialState;

/** The kinds a listing that names no kind leaves out. */
export const UNLISTED_KINDS: readonly string[] = CORE_THREAD_KINDS.filter(
	(declared) => declared.unlisted,
).map((declared) => declared.name);
