import type { Db } from "./db/port";
import { TABLES } from "./db/tables";
import { Modules } from "./module";
import { RECORD_TABLES, type RecordTable } from "./schemas/record";
import { SYNC_TABLES, type SyncTable } from "./schemas/sync";

/** Each core table's thread column; a thread's is its own id. */
const coreThreadColumn = {
	threads: "id",
	entries: "thread_id",
	attributes: "thread_id",
	refs: "thread_id",
	[TABLES.projects]: null,
} satisfies Record<SyncTable | RecordTable, string | null>;

type Table = {
	table: string;
	threadColumn: string | null;
	unregisteredModule?: string;
};

export namespace Replicated {
	export const threadTable = TABLES.threads;

	/** Core's replicated tables: the record's, then the rest. */
	export const CORE_TABLES: readonly string[] = [
		...RECORD_TABLES,
		...SYNC_TABLES,
	];

	/**
	 * Every replicated table with its thread column: core's, each registered
	 * module's, and each unregistered module's recorded tables. Export,
	 * capture and backfill read this one declaration.
	 */
	export const tables = (db: Db): Table[] =>
		[
			...[...RECORD_TABLES, ...SYNC_TABLES].map((table) => ({
				table,
				threadColumn: coreThreadColumn[table],
			})),
			...Modules.tables().map(({ spec }) => ({
				table: spec.table,
				threadColumn: spec.childOfTasks ? "task_id" : null,
			})),
			...Modules.unregistered(db).map(({ table, childOfTasks, tag }) => ({
				table,
				threadColumn: childOfTasks ? "task_id" : null,
				unregisteredModule: tag.name,
			})),
		].sort((a, b) => a.table.localeCompare(b.table));
}
