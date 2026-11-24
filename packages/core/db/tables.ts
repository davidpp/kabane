/**
 * Table names: what the DDL creates, what SQL statements address and what the
 * sync wire carries in an op's `tbl`.
 */

export const TABLES = {
	/** A view since migration 14: the old task row over the record (`storage/record-migration.ts`). */
	tasks: "tasks",
	tasks_fts: "tasks_fts",
	sequences: "sequences",
	projects: "projects",
	sync_oplog: "sync_oplog",
	sync_state: "sync_state",
	sync_quarantine: "sync_quarantine",
	sync_parked: "sync_parked",
	sync_parked_deletes: "sync_parked_deletes",
	short_id_history: "short_id_history",
	schema_migrations: "schema_migrations",
	/** Migration 14 renames the old task table here: module tables may still reference it. */
	retired_tasks: "retired_tasks",
	// The 2.0 record (ADR 0006); migration 14 moved today's task tables into it.
	threads: "threads",
	entries: "entries",
	attributes: "attributes",
	refs: "refs",
	// Bookkeeping of the module pass, created idempotently, never replicated (`Modules.ensureDeclarations`).
	module_declarations: "module_declarations",
} as const;

export type TableKey = keyof typeof TABLES;
