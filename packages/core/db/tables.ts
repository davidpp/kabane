/**
 * Table names: what the DDL creates, what SQL statements address and what the
 * sync wire carries in an op's `tbl`.
 */

export const TABLES = {
	/** A view since migration 14: the old task row over the record (`storage/record-migration.ts`). */
	tasks: "tasks",
	tasks_fts: "tasks_fts",
	/** A view since migration 14: every thread's task row, before visibility. */
	task_rows: "task_rows",
	// Retired by migration 14 into the record; the shipped migrations before it
	// still write them by these names.
	task_links: "task_links",
	comments: "task_comments",
	comments_fts: "task_comments_fts",
	work_log: "task_work_log",
	context_refs: "task_context_refs",
	upstream_links: "upstream_links",
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
