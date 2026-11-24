/**
 * Migration 4 moves `task_questions` rows onto the record: an ask entry per
 * question and a reply per closed one, read back as the row read (its audit
 * fields included), the same entries on two devices that migrate the same
 * rows apart, and a parked legacy op stopping it with nothing changed.
 */

import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result, withDb } from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { decodeTime } from "ulid";
import { migrations } from "./migrations";
import { questionsModule } from "./module";
import { Questions } from "./storage";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const bases: string[] = [];
afterEach(() => {
	configureTestRuntime();
	for (const base of bases.splice(0))
		rmSync(base, { recursive: true, force: true });
});

const AT = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";
const AGENT = "kabane://actor/agent/claude";
const RELAY = "kabane://actor/agent/copilot";
const HUMAN = "kabane://actor/human/david";

type Row = {
	id: string;
	status: string;
	by?: string;
	at?: string;
	updatedAt?: string;
	updatedBy?: string;
	version?: number;
	why?: string;
	answer?: string;
	reasoning?: string;
};

const ROWS: Row[] = [
	{
		id: "01KQ0000000000000000000001",
		status: "open",
		why: "it matters",
		updatedBy: RELAY,
	},
	{
		id: "01KQ0000000000000000000002",
		status: "answered",
		by: HUMAN,
		at: LATER,
		answer: "This one",
		reasoning: "cheaper",
		version: 3,
	},
	{
		id: "01KQ0000000000000000000003",
		status: "withdrawn",
		by: AGENT,
		at: LATER,
		reasoning: "issue closed",
	},
];

/** A device at questions schema 3 holding `rows` on one issue. */
const legacy = async (taskKey: string, rows: Row[] = ROWS) => {
	const base = mkdtempSync(join(tmpdir(), "kabane-questions-migrate-"));
	bases.push(base);
	configureTestRuntime({
		modules: [{ ...questionsModule, migrations: migrations.slice(0, 3) }],
		actor: () => AGENT,
	});
	unwrap(await Planner.init(base));
	const task = unwrap(
		await Planner.addTask(
			base,
			{ title: "Decide", kind: "issue", scopeUri: "questions" },
			{ key: taskKey },
		),
	);
	for (const row of rows)
		unwrap(
			await withDb(base, (db) =>
				db.run(
					`INSERT INTO task_questions (id, task_id, status, asked_by, answered_by, answered_at,
					   created_at, updated_at, updated_by, version, body, why, answer, reasoning)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						row.id,
						task.id,
						row.status,
						AGENT,
						row.by ?? null,
						row.at ?? null,
						AT,
						row.updatedAt ?? row.at ?? AT,
						row.updatedBy ?? row.by ?? AGENT,
						row.version ?? (row.status === "open" ? 1 : 2),
						`Which ${row.id}?`,
						row.why ?? null,
						row.answer ?? null,
						row.reasoning ?? null,
					],
				),
			),
		);
	return { base, taskId: task.id };
};

const upgrade = async (base: string) => {
	configureTestRuntime({ modules: [questionsModule], actor: () => AGENT });
	return Planner.init(base);
};

const migrated = async (taskKey: string, rows: Row[] = ROWS) => {
	const device = await legacy(taskKey, rows);
	unwrap(await upgrade(device.base));
	return device;
};

const entries = async (base: string) =>
	unwrap(
		await withDb(base, (db) =>
			db
				.query<Record<string, unknown>, []>(
					"SELECT * FROM entries WHERE kind LIKE 'questions.%' ORDER BY id",
				)
				.all(),
		),
	);

it("moves each question onto the record and reads it back as the row read, audit fields included", async () => {
	const { base, taskId } = await migrated("migrate/one");
	const rows = unwrap(
		await Questions.list(base, { id: taskId, status: "all" }),
	);
	expect(
		rows.map((row) => ({
			id: row.id,
			status: row.status,
			askedBy: row.askedBy,
			answeredBy: row.answeredBy,
			answeredAt: row.answeredAt,
			updatedAt: row.updatedAt,
			updatedBy: row.updatedBy,
			answer: row.answer,
			reasoning: row.reasoning,
			why: row.why,
			version: row.version,
			ordinal: row.ordinal,
		})),
	).toEqual([
		{
			id: "01KQ0000000000000000000001",
			status: "open",
			askedBy: AGENT,
			answeredBy: undefined,
			answeredAt: undefined,
			updatedAt: AT,
			updatedBy: RELAY,
			answer: undefined,
			reasoning: undefined,
			why: "it matters",
			version: 1,
			ordinal: 1,
		},
		{
			id: "01KQ0000000000000000000002",
			status: "answered",
			askedBy: AGENT,
			answeredBy: HUMAN,
			answeredAt: LATER,
			updatedAt: LATER,
			updatedBy: HUMAN,
			answer: "This one",
			reasoning: "cheaper",
			why: undefined,
			version: 3,
			ordinal: 2,
		},
		{
			id: "01KQ0000000000000000000003",
			status: "withdrawn",
			askedBy: AGENT,
			answeredBy: AGENT,
			answeredAt: LATER,
			updatedAt: LATER,
			updatedBy: AGENT,
			answer: undefined,
			reasoning: "issue closed",
			why: undefined,
			version: 2,
			ordinal: 3,
		},
	]);
	// A later answer counts from the stored version.
	const again = unwrap(
		await Questions.answer(base, {
			question: ROWS[1]?.id ?? "",
			answer: "That one",
		}),
	);
	expect(again.question.version).toBe(4);
	const gone = unwrap(
		await withDb(base, (db) =>
			db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) n FROM sqlite_master WHERE name = 'task_questions'",
				)
				.get(),
		),
	);
	expect(gone?.n).toBe(0);
});

it("two devices migrating the same rows write the same entries", async () => {
	const one = await migrated("migrate/same");
	const two = await migrated("migrate/same");
	expect(await entries(one.base)).toEqual(await entries(two.base));
	expect(await entries(one.base)).toHaveLength(5);
});

it("a question answered in the millisecond its id was minted migrates", async () => {
	const id = "01KQ0000000000000000000009";
	// Answered in the millisecond the question's id carries.
	const at = new Date(decodeTime(id)).toISOString();
	const { base, taskId } = await migrated("migrate/fast", [
		{ id, status: "answered", by: HUMAN, at, answer: "Yes" },
	]);
	expect(
		unwrap(await Questions.list(base, { id: taskId, status: "all" })).map(
			(row) => [row.id, row.status, row.answer],
		),
	).toEqual([[id, "answered", "Yes"]]);
});

it("a device that already received another device's migrated entries upgrades and keeps one of each", async () => {
	const source = await migrated("migrate/partial");
	const received = await entries(source.base);
	const late = await legacy("migrate/partial");
	// It pulled them while the module was off: stored as core entries.
	unwrap(
		await withDb(late.base, (db) => {
			for (const row of received) {
				const columns = Object.keys(row);
				db.run(
					`INSERT INTO entries (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
					columns.map((column) => row[column] as string | number | null),
				);
			}
		}),
	);
	unwrap(await upgrade(late.base));
	expect(await entries(late.base)).toEqual(received);
});

it("refuses, changing nothing, while a legacy question op is parked", async () => {
	const { base, taskId } = await legacy("migrate/parked");
	unwrap(
		await withDb(base, (db) =>
			db.run(
				`INSERT INTO sync_parked (op_id, server_seq, module, module_schema, tbl, row_id, op, parked_at)
				 VALUES ('op-1', 7, 'questions', 3, 'task_questions', 'q-1', '{}', ?)`,
				[AT],
			),
		),
	);
	const refused = await upgrade(base);
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.error.message).toContain("parked");
	const left = unwrap(
		await withDb(base, (db) => ({
			parked: db
				.query<{ n: number }, []>("SELECT COUNT(*) n FROM sync_parked")
				.get()?.n,
			rows: db
				.query<{ n: number }, [string]>(
					"SELECT COUNT(*) n FROM task_questions WHERE task_id = ?",
				)
				.get(taskId)?.n,
		})),
	);
	expect(left).toEqual({ parked: 1, rows: 3 });
});
