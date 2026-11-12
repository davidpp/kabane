import { type Migrate, TABLES } from "@cabane/core";

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
];
