/**
 * Physical table names.
 *
 * Every table has a logical name (what the DDL and the sync wire use) and a
 * physical name (what SQL statements address). The two differ only by a
 * configurable prefix: Jake shares one `jake.db` with other modules and needs
 * `planner_tasks`; a standalone Cabane database uses `tasks`.
 *
 * `TABLES` exposes the physical names through getters so the prefix can be set
 * once at configure time and every call site written as `${TABLES.tasks}`
 * inside a function body picks it up. Do NOT capture `TABLES.x` into a
 * module-level constant — that evaluates at import, before configuration.
 */

export const LOGICAL_TABLES = {
	tasks: "tasks",
	tasks_fts: "tasks_fts",
	task_links: "task_links",
	focus_lists: "focus_lists",
	proposals: "proposals",
	proposals_fts: "proposals_fts",
	sequences: "sequences",
	comments: "task_comments",
	comments_fts: "task_comments_fts",
	work_log: "task_work_log",
	activity: "task_activity",
	context_refs: "task_context_refs",
	upstream_links: "upstream_links",
	projects: "projects",
	agent_sessions: "agent_sessions",
	agent_activities: "agent_activities",
	sync_oplog: "sync_oplog",
	sync_state: "sync_state",
	sync_quarantine: "sync_quarantine",
	short_id_history: "short_id_history",
	schema_migrations: "schema_migrations",
} as const;

export type TableKey = keyof typeof LOGICAL_TABLES;

let prefix = "";

/** Set the physical-name prefix, e.g. "planner_". Empty means plain names. */
export const setTablePrefix = (value: string): void => {
	prefix = value;
};

/** The prefix in force. Trigger and index names built in code use it too. */
export const tablePrefix = (): string => prefix;

/** Physical name for a logical table name. */
export const physicalTable = (logical: string): string => `${prefix}${logical}`;

const defineTables = (): Record<TableKey, string> => {
	const out = {} as Record<TableKey, string>;
	for (const key of Object.keys(LOGICAL_TABLES) as TableKey[]) {
		Object.defineProperty(out, key, {
			enumerable: true,
			get: () => physicalTable(LOGICAL_TABLES[key]),
		});
	}
	return out;
};

export const TABLES: Readonly<Record<TableKey, string>> = defineTables();
