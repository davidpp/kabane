import {
	ActorScheme,
	type Db,
	mergeRecordRow,
	type Migrate,
	TABLES,
} from "@kabane/core";
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
			refuseParked(db);
			for (const row of db
				.query<QuestionRow, []>(`SELECT * FROM ${QUESTIONS_TABLE} ORDER BY id`)
				.all())
				moveQuestion(db, row);
			for (const table of [
				TABLES.sync_oplog,
				TABLES.sync_parked_deletes,
				TABLES.sync_quarantine,
			])
				db.run(`DELETE FROM ${table} WHERE tbl = ?`, [QUESTIONS_TABLE]);
			db.run(`DROP TABLE ${QUESTIONS_TABLE}`);
		},
	},
];

/**
 * A parked op for the old table is a question this device holds nowhere
 * else: the module never applied it. Refuse, changing nothing, until it is.
 */
const refuseParked = (db: Db): void => {
	const parked = db
		.query<{ n: number }, [string]>(
			`SELECT COUNT(*) AS n FROM ${TABLES.sync_parked} WHERE tbl = ?`,
		)
		.get(QUESTIONS_TABLE)?.n;
	if (parked)
		throw new Error(
			`${parked} ${QUESTIONS_TABLE} ops are parked here, questions no other row holds; restore the pre-upgrade backup before opening it with the previous release, enable the questions module and sync once to apply them, then upgrade.`,
		);
};

type QuestionRow = {
	id: string;
	task_id: string;
	status: string;
	asked_by: string;
	answered_by: string | null;
	answered_at: string | null;
	created_at: string;
	updated_at: string;
	updated_by: string;
	version: number;
	visibility: string;
	body: string;
	why: string | null;
	answer: string | null;
	reasoning: string | null;
};

/**
 * Write one migrated entry. A device can already hold it, pulled from a
 * device that migrated first while this one ran the module's older schema:
 * the two values merge as sync would merge them, so the entry is never
 * written twice and a later value wins.
 */
const putEntry = (
	db: Db,
	entry: {
		id: string;
		thread_id: string;
		kind: string;
		author: string;
		body: string | null;
		re: string | null;
		data: Record<string, string | number> | null;
		visibility: string;
		created_at: string;
		updated_by: string;
	},
): void => {
	const row: Record<string, unknown> = {
		...entry,
		kind_version: null,
		addressed_to: null,
		data: entry.data === null ? null : JSON.stringify(entry.data),
		created_device: "",
		version: 1,
	};
	const held = db
		.query<Record<string, unknown>, [string]>(
			`SELECT * FROM ${TABLES.entries} WHERE id = ?`,
		)
		.get(entry.id);
	const merged = held === null ? row : mergeRecordRow("entries", held, row);
	if (merged === held) return;
	const columns = Object.keys(merged);
	db.run(
		`INSERT OR REPLACE INTO ${TABLES.entries} (${columns.join(", ")})
		 VALUES (${columns.map(() => "?").join(", ")})`,
		columns.map((column) => merged[column] as string | number | null),
	);
};

/**
 * The ask keeps the question's id, and a closed question's reply takes the id
 * `reply:<question id>`, so every device derives the same ones and no reply
 * can take an ask's. The row kept only its last closing, so a re-answered
 * question has one reply. The entry that now decides the question (its reply,
 * or the ask while it is open) carries the row's version and update time,
 * which the read prefers to its own count and clock, and its writer.
 */
const moveQuestion = (db: Db, row: QuestionRow): void => {
	const open = row.status === "open";
	const audit = { version: row.version, updatedAt: row.updated_at };
	putEntry(db, {
		id: row.id,
		thread_id: row.task_id,
		kind: ASK_KIND,
		author: row.asked_by,
		body: row.body,
		re: null,
		data:
			row.why === null && !open
				? null
				: {
						...(row.why === null ? {} : { why: row.why }),
						...(open ? audit : {}),
					},
		visibility: row.visibility,
		created_at: row.created_at,
		updated_by: open ? row.updated_by : row.asked_by,
	});
	if (open) return;
	putEntry(db, {
		id: `reply:${row.id}`,
		thread_id: row.task_id,
		kind: row.status === "answered" ? ANSWER_KIND : WITHDRAW_KIND,
		author: row.answered_by ?? row.updated_by,
		body: row.status === "answered" ? row.answer : null,
		re: row.id,
		data: {
			...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
			...audit,
		},
		visibility: row.visibility,
		created_at: row.answered_at ?? row.updated_at,
		updated_by: row.updated_by,
	});
};
