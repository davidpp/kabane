import type { Db } from "./db/port";
import { TABLES } from "./db/tables";
import { Modules } from "./module";
import { SYNC_TABLES, type SyncTable } from "./schemas/sync";

const coreThreadColumn = {
	[TABLES.tasks]: null,
	[TABLES.comments]: "task_id",
	[TABLES.work_log]: "task_id",
	[TABLES.context_refs]: "task_id",
	[TABLES.upstream_links]: "task_id",
	[TABLES.task_links]: "source_id",
	[TABLES.projects]: null,
} satisfies Record<SyncTable, string | null>;

type Table = {
	table: string;
	threadColumn: string | null;
	unregisteredModule?: string;
};

export namespace Replicated {
	export const threadTable = TABLES.tasks;

	/** Oplog capture should use this declaration too when the record tables land. */
	export const tables = (db: Db): Table[] =>
		[
			...SYNC_TABLES.map((table) => ({
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
