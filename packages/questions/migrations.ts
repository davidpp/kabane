import { type Migrate, physicalTable, TABLES } from "@cabane/core";

export const QUESTIONS_TABLE = "task_questions";
export const questionsTable = (): string => physicalTable(QUESTIONS_TABLE);

export const migrations: readonly Migrate.Migration[] = [
	{
		name: "create-task-questions",
		up: (db) => {
			db.run(`CREATE TABLE ${questionsTable()} (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL REFERENCES ${TABLES.tasks}(id) ON DELETE CASCADE,
			status TEXT NOT NULL DEFAULT 'open',
			asked_by TEXT NOT NULL,
			answered_by TEXT,
			answered_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 1,
			visibility TEXT NOT NULL DEFAULT 'shared',
			body TEXT NOT NULL,
			why TEXT,
			answer TEXT,
			reasoning TEXT
		)`);
			db.run(
				`CREATE INDEX ${physicalTable("idx_task_questions_task_status")} ON ${questionsTable()} (task_id, status)`,
			);
		},
	},
];
