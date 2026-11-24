import { ActorScheme, type Migrate, TABLES } from "@kabane/core";

export const ITEMS_TABLE = "task_checklist_items";

export const migrations: readonly Migrate.Migration[] = [
	{
		name: "create-task-checklist-items",
		up: (db) => {
			// A removed item keeps its row (removed_at), so no handle on its issue renumbers.
			db.run(`CREATE TABLE ${ITEMS_TABLE} (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES ${TABLES.tasks}(id) ON DELETE CASCADE,
			text TEXT NOT NULL,
			rank TEXT NOT NULL,
			done_at TEXT,
			done_by TEXT,
			removed_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 1,
			visibility TEXT NOT NULL DEFAULT 'shared'
		)`);
			db.run(
				`CREATE INDEX idx_task_checklist_items_task_rank ON ${ITEMS_TABLE} (task_id, rank)`,
			);
		},
	},
	{
		// `cabane://actor/` became `kabane://actor/` (core's migration 12, JCAB-607).
		name: "actor-scheme",
		up: (db) =>
			ActorScheme.renameColumns(db, ITEMS_TABLE, ["done_by", "updated_by"]),
	},
	{
		// Core's migration 14 moved tasks into the record and made `tasks` a view
		// (JCAB-660). An item's task is a thread now, checked by the record's
		// reads rather than a foreign key, which no view can be: the table is
		// rebuilt without one, every row kept.
		name: "detach-from-tasks",
		up: (db) => {
			db.run(`CREATE TABLE ${ITEMS_TABLE}_new (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			text TEXT NOT NULL,
			rank TEXT NOT NULL,
			done_at TEXT,
			done_by TEXT,
			removed_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 1,
			visibility TEXT NOT NULL DEFAULT 'shared'
		)`);
			db.run(
				`INSERT INTO ${ITEMS_TABLE}_new
				   (id, task_id, text, rank, done_at, done_by, removed_at, created_at,
				    updated_at, updated_by, version, visibility)
				 SELECT id, task_id, text, rank, done_at, done_by, removed_at, created_at,
				        updated_at, updated_by, version, visibility
				   FROM ${ITEMS_TABLE}`,
			);
			db.run(`DROP TABLE ${ITEMS_TABLE}`);
			db.run(`ALTER TABLE ${ITEMS_TABLE}_new RENAME TO ${ITEMS_TABLE}`);
			db.run(
				`CREATE INDEX idx_task_checklist_items_task_rank ON ${ITEMS_TABLE} (task_id, rank)`,
			);
		},
	},
];
