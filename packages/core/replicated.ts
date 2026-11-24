import { Migrate } from "./db/migrate";
import type { Db } from "./db/port";
import { TABLES } from "./db/tables";
import { Modules } from "./module";
import { SYNC_TABLES } from "./schemas/sync";

/** One replicated table, as export, backfill and capture all read it. */
type ReplicatedTable = {
	table: string;
	/** The column naming the row's thread; a thread's is its own id. */
	threadColumn: string | null;
	/**
	 * A module's table its code no longer registers on this device, with the
	 * tag its recorded declaration carries: capture takes only a delete there.
	 */
	unregisteredModule?: string;
	tag?: { name: string; schema: number };
	/**
	 * A table migration 14 moved into the record. Capture takes a write to it
	 * only before 14 has run, from the shipped migrations that write it, and 14
	 * drops those ops; nothing enumerates it.
	 */
	retired?: true;
};

/** The core schema version that retired the task tables (`record-migrate`). */
const RECORD_MIGRATION = 14;

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

/** Core's tables and each registered module's: known with no database read. */
const declared = (): ReplicatedTable[] => [
	...CORE,
	...Modules.tables().map(({ spec }) => ({
		table: spec.table,
		threadColumn: spec.childOfTasks ? "task_id" : null,
	})),
];

/** Each unregistered module's recorded tables (`module_declarations`). */
const recorded = (db: Db): ReplicatedTable[] =>
	Modules.unregistered(db).map(({ table, childOfTasks, tag }) => ({
		table,
		threadColumn: childOfTasks ? "task_id" : null,
		unregisteredModule: tag.name,
		tag,
	}));

export namespace Replicated {
	export const threadTable = TABLES.threads;

	/**
	 * The table `tbl` names: one `tables` enumerates, or a retired one while
	 * the database is still before migration 14.
	 */
	export const lookup = (db: Db, tbl: string): ReplicatedTable | undefined => {
		const named = ({ table }: ReplicatedTable) => table === tbl;
		return (
			declared().find(named) ??
			(Migrate.current(db) < RECORD_MIGRATION
				? RETIRED.find(named)
				: undefined) ??
			recorded(db).find(named)
		);
	};

	/**
	 * Every live replicated table: core's, each registered module's, and each
	 * unregistered module's recorded tables. Export and backfill enumerate this.
	 */
	export const tables = (db: Db): ReplicatedTable[] =>
		[...declared(), ...recorded(db)].sort((a, b) =>
			a.table.localeCompare(b.table),
		);
}
