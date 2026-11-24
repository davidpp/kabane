import type { Db } from "./db/port";
import { TABLES } from "./db/tables";
import { Modules } from "./module";
import { SYNC_TABLES } from "./schemas/sync";

/** One replicated table, as export, backfill and capture all read it. */
type ReplicatedTable = {
	table: string;
	/** The column naming the row's thread; a thread's is its own id. */
	threadColumn: string | null;
	/** A module's table its code no longer registers on this device. */
	unregisteredModule?: string;
	/**
	 * A table migration 14 moved into the record. Capture still takes a write
	 * to it, which only the shipped migrations before 14 make, and 14 drops
	 * those ops; nothing enumerates it.
	 */
	retired?: true;
};

const CORE: readonly ReplicatedTable[] = [
	{ table: TABLES.threads, threadColumn: "id" },
	{ table: TABLES.entries, threadColumn: "thread_id" },
	{ table: TABLES.attributes, threadColumn: "thread_id" },
	{ table: TABLES.refs, threadColumn: "thread_id" },
	...SYNC_TABLES.map((table) => ({ table, threadColumn: null })),
];

const RETIRED: readonly ReplicatedTable[] = [
	{ table: TABLES.tasks, threadColumn: null, retired: true },
	{ table: TABLES.comments, threadColumn: "task_id", retired: true },
	{ table: TABLES.work_log, threadColumn: "task_id", retired: true },
	{ table: TABLES.task_links, threadColumn: "source_id", retired: true },
	{ table: TABLES.context_refs, threadColumn: "task_id", retired: true },
	{ table: TABLES.upstream_links, threadColumn: "task_id", retired: true },
];

const registered = (): ReplicatedTable[] =>
	Modules.tables().map(({ spec }) => ({
		table: spec.table,
		threadColumn: spec.childOfTasks ? "task_id" : null,
	}));

export namespace Replicated {
	export const threadTable = TABLES.threads;

	/**
	 * The table `tbl` names among core's, the retired ones and the registered
	 * modules': what capture checks a write against, with no database read.
	 */
	export const lookup = (tbl: string): ReplicatedTable | undefined =>
		[...CORE, ...RETIRED, ...registered()].find(({ table }) => table === tbl);

	/**
	 * Every live replicated table: core's, each registered module's, and each
	 * unregistered module's recorded tables. Export and backfill enumerate this.
	 */
	export const tables = (db: Db): ReplicatedTable[] =>
		[
			...CORE,
			...registered(),
			...Modules.unregistered(db).map(({ table, childOfTasks, tag }) => ({
				table,
				threadColumn: childOfTasks ? "task_id" : null,
				unregisteredModule: tag.name,
			})),
		].sort((a, b) => a.table.localeCompare(b.table));
}
