import { ActorScheme, type Migrate, TABLES } from "@kabane/core";

export const QUESTIONS_TABLE = "task_questions";

export const migrations: readonly Migrate.Migration[] = [
	{
		name: "create-task-questions",
		up: (db) => {
			db.run(`CREATE TABLE ${QUESTIONS_TABLE} (
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
				`CREATE INDEX idx_task_questions_task_status ON ${QUESTIONS_TABLE} (task_id, status)`,
			);
		},
	},
	{
		// `cabane://actor/` became `kabane://actor/` (core's migration 12, JCAB-607).
		name: "actor-scheme",
		up: (db) =>
			ActorScheme.renameColumns(db, QUESTIONS_TABLE, [
				"asked_by",
				"answered_by",
				"updated_by",
			]),
	},
	{
		// Core's migration 14 moved tasks into the record and made `tasks` a view
		// (JCAB-660). A row's task is a thread now, checked by the record's reads
		// rather than a foreign key, which no view can be: the table is rebuilt
		// without one, every row kept.
		name: "detach-from-tasks",
		up: (db) => {
			db.run(`CREATE TABLE ${QUESTIONS_TABLE}_new (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
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
				`INSERT INTO ${QUESTIONS_TABLE}_new
				   (id, task_id, status, asked_by, answered_by, answered_at, created_at,
				    updated_at, updated_by, version, visibility, body, why, answer, reasoning)
				 SELECT id, task_id, status, asked_by, answered_by, answered_at, created_at,
				        updated_at, updated_by, version, visibility, body, why, answer, reasoning
				   FROM ${QUESTIONS_TABLE}`,
			);
			db.run(`DROP TABLE ${QUESTIONS_TABLE}`);
			db.run(`ALTER TABLE ${QUESTIONS_TABLE}_new RENAME TO ${QUESTIONS_TABLE}`);
			db.run(
				`CREATE INDEX idx_task_questions_task_status ON ${QUESTIONS_TABLE} (task_id, status)`,
			);
		},
	},
];
