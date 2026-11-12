/**
 * Table names: what the DDL creates, what SQL statements address and what the
 * sync wire carries in an op's `tbl`.
 */

export const TABLES = {
	tasks: "tasks",
	tasks_fts: "tasks_fts",
	task_links: "task_links",
	sequences: "sequences",
	comments: "task_comments",
	comments_fts: "task_comments_fts",
	work_log: "task_work_log",
	context_refs: "task_context_refs",
	upstream_links: "upstream_links",
	projects: "projects",
	agent_sessions: "agent_sessions",
	agent_activities: "agent_activities",
	sync_oplog: "sync_oplog",
	sync_state: "sync_state",
	sync_quarantine: "sync_quarantine",
	sync_parked: "sync_parked",
	sync_parked_deletes: "sync_parked_deletes",
	short_id_history: "short_id_history",
	schema_migrations: "schema_migrations",
} as const;

export type TableKey = keyof typeof TABLES;
