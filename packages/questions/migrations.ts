import { ActorScheme, type Db, type Migrate, TABLES } from "@kabane/core";
import { encodeTime } from "ulid";
import { ANSWER_KIND, ASK_KIND, WITHDRAW_KIND } from "./kinds";

const QUESTIONS_TABLE = "task_questions";

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
	{
		// Questions become entries on the record (ADR 0006): an ask, and a reply
		// for each closed one. Every value comes from the row, so two devices that
		// migrate the same rows write the same entries; the table and its unsent
		// ops go, and an armed device backfills (core's migration 14 does the same).
		name: "questions-into-entries",
		up: (db) => {
			for (const row of db
				.query<QuestionRow, []>(`SELECT * FROM ${QUESTIONS_TABLE} ORDER BY id`)
				.all())
				moveQuestion(db, row);
			for (const table of [
				TABLES.sync_oplog,
				TABLES.sync_parked,
				TABLES.sync_parked_deletes,
				TABLES.sync_quarantine,
			])
				db.run(`DELETE FROM ${table} WHERE tbl = ?`, [QUESTIONS_TABLE]);
			db.run(`DROP TABLE ${QUESTIONS_TABLE}`);
		},
	},
];

type QuestionRow = {
	id: string;
	task_id: string;
	status: string;
	asked_by: string;
	answered_by: string | null;
	answered_at: string | null;
	created_at: string;
	updated_by: string;
	visibility: string;
	body: string;
	why: string | null;
	answer: string | null;
	reasoning: string | null;
};

const insertEntry = (
	db: Db,
	entry: {
		id: string;
		threadId: string;
		kind: string;
		author: string;
		body: string | null;
		re: string | null;
		data: Record<string, string> | null;
		visibility: string;
		createdAt: string;
		updatedBy: string;
	},
) =>
	db.run(
		`INSERT INTO ${TABLES.entries}
		   (id, thread_id, kind, author, body, re, data, visibility, created_at, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			entry.id,
			entry.threadId,
			entry.kind,
			entry.author,
			entry.body,
			entry.re,
			entry.data === null ? null : JSON.stringify(entry.data),
			entry.visibility,
			entry.createdAt,
			entry.updatedBy,
		],
	);

/**
 * The ask keeps the question's id; the reply's id takes the time it was
 * closed and the question id's random part, so every device derives the same
 * one. The row kept only its last closing, so a re-answered question has one
 * reply.
 */
const moveQuestion = (db: Db, row: QuestionRow): void => {
	insertEntry(db, {
		id: row.id,
		threadId: row.task_id,
		kind: ASK_KIND,
		author: row.asked_by,
		body: row.body,
		re: null,
		data: row.why === null ? null : { why: row.why },
		visibility: row.visibility,
		createdAt: row.created_at,
		updatedBy: row.asked_by,
	});
	if (row.status === "open") return;
	const closedAt = row.answered_at ?? row.created_at;
	insertEntry(db, {
		id: encodeTime(Date.parse(closedAt), 10) + row.id.slice(10),
		threadId: row.task_id,
		kind: row.status === "answered" ? ANSWER_KIND : WITHDRAW_KIND,
		author: row.answered_by ?? row.updated_by,
		body: row.status === "answered" ? row.answer : null,
		re: row.id,
		data: row.reasoning === null ? null : { reasoning: row.reasoning },
		visibility: row.visibility,
		createdAt: closedAt,
		updatedBy: row.updated_by,
	});
};
