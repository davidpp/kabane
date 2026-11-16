import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Db,
	err,
	type KabaneModule,
	ok,
	Oplog,
	PLANNER_EVENTS,
	Planner,
	type Result,
	withDb,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { createHostStore } from "./host-store";

const NOTES = "kit_notes";
const notes: KabaneModule = {
	name: "kit",
	migrations: [
		{
			name: "create-kit-notes",
			up: (db) =>
				db.run(
					`CREATE TABLE ${NOTES} (
					   id TEXT PRIMARY KEY,
					   task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
					   body TEXT NOT NULL,
					   updated_at TEXT NOT NULL,
					   updated_by TEXT,
					   version INTEGER NOT NULL DEFAULT 1,
					   visibility TEXT NOT NULL DEFAULT 'shared'
					 )`,
				),
		},
	],
	syncTables: [
		{
			table: NOTES,
			family: "row-lww",
			clock: "updated_at",
			childOfTasks: true,
		},
	],
};

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

let home: string;
let events: { type: string; payload: unknown }[];

beforeEach(async () => {
	events = [];
	configureTestRuntime({
		modules: [notes],
		notifier: async (type, payload) => {
			events.push({ type, payload });
		},
	});
	home = mkdtempSync(join(tmpdir(), "kabane-store-"));
	value(await Planner.init(home));
	value(value(await withDb(home, (db) => Oplog.initDevice(db, "kit"))));
});

afterEach(() => {
	configureTestRuntime();
	rmSync(home, { recursive: true, force: true });
});

const store = () =>
	createHostStore(
		() => home,
		() => [NOTES],
	);

const insert = (db: Db, taskId: string, id: string) =>
	db.run(
		`INSERT INTO ${NOTES} (id, task_id, body, updated_at) VALUES (?, ?, 'note', ?)`,
		[id, taskId, new Date().toISOString()],
	);

const oplog = () =>
	withDb(home, (db) =>
		db
			.query<{ tbl: string; op: string }, []>(
				"SELECT tbl, op FROM sync_oplog ORDER BY seq",
			)
			.all(),
	);

it("commits a row and its capture, and emits TASK_UPDATED only after the commit", async () => {
	const task = value(
		await Planner.addTask(home, { title: "Kit", kind: "issue" }),
	);
	events = [];
	const seenInside: number[] = [];
	const written = await store().write((tx) => {
		insert(tx.db, task.id, "n1");
		const captured = tx.afterWrite(NOTES, "insert", "n1");
		if (!captured.ok) return captured;
		const updated = tx.updateTask(task.id, { state: "next" });
		seenInside.push(events.length);
		return updated.ok ? ok(updated.value?.state) : updated;
	});
	expect(written).toEqual(ok("next"));
	expect(seenInside).toEqual([0]);
	expect(events).toMatchObject([
		{
			type: PLANNER_EVENTS.TASK_UPDATED,
			payload: { id: task.id, state: "next" },
		},
	]);
	expect(value(await oplog()).slice(-2)).toEqual([
		{ tbl: NOTES, op: "insert" },
		{ tbl: "tasks", op: "update" },
	]);
});

it("rolls everything back and emits nothing when fn returns an err", async () => {
	const task = value(
		await Planner.addTask(home, { title: "Kit", kind: "issue" }),
	);
	events = [];
	const before = value(await oplog());
	const written = await store().write((tx) => {
		insert(tx.db, task.id, "n1");
		tx.afterWrite(NOTES, "insert", "n1");
		tx.updateTask(task.id, { state: "done" });
		return err(new Error("the extension changed its mind"));
	});
	expect(written.ok ? "" : written.error.message).toBe(
		"the extension changed its mind",
	);
	expect(events).toEqual([]);
	expect(value(await oplog())).toEqual(before);
	expect(
		value(
			await store().read((db) => ok(db.query(`SELECT * FROM ${NOTES}`).all())),
		),
	).toEqual([]);
	expect(value(await Planner.getTask(home, task.id))?.state).toBe("inbox");
});

it("refuses a table the extension's modules do not declare, and rolls back even when fn ignores the refusal", async () => {
	const task = value(
		await Planner.addTask(home, { title: "Kit", kind: "issue" }),
	);
	const before = value(await oplog());
	const written = await store().write((tx) => {
		insert(tx.db, task.id, "n1");
		tx.afterWrite(NOTES, "insert", "n1");
		const refused = tx.afterWrite("tasks", "update", task.id);
		expect(refused.ok).toBe(false);
		return ok("ignored");
	});
	expect(written.ok ? "" : written.error.message).toContain(
		'"tasks" is no table this extension\'s modules declare',
	);
	expect(value(await oplog())).toEqual(before);
	expect(
		value(
			await store().read((db) => ok(db.query(`SELECT * FROM ${NOTES}`).all())),
		),
	).toEqual([]);
});

it("captures a delete of its own rows from the snapshot", async () => {
	const task = value(
		await Planner.addTask(home, { title: "Kit", kind: "issue" }),
	);
	value(
		await store().write((tx) => {
			insert(tx.db, task.id, "n1");
			return tx.afterWrite(NOTES, "insert", "n1");
		}),
	);
	value(
		await store().write((tx) => {
			const row = tx.snapshot(NOTES, "n1");
			if (!row.ok || !row.value) return row.ok ? ok(undefined) : row;
			tx.db.run(`DELETE FROM ${NOTES} WHERE id = ?`, ["n1"]);
			return tx.afterDelete([{ tbl: NOTES, row: row.value }]);
		}),
	);
	expect(value(await oplog()).slice(-1)).toEqual([
		{ tbl: NOTES, op: "delete" },
	]);
});

it("reads on a connection that refuses writes", async () => {
	const read = await store().read((db) => {
		db.run(`DELETE FROM ${NOTES}`);
		return ok(undefined);
	});
	expect(read.ok ? "" : read.error.message).toContain("readonly");
});

it("returns the not-configured err before the store opens", async () => {
	const closed = createHostStore(
		() => undefined,
		() => [NOTES],
	);
	for (const result of [
		await closed.read(() => ok(1)),
		await closed.write(() => ok(1)),
	])
		expect(result.ok ? "" : result.error.message).toContain(
			"not configured yet",
		);
});
