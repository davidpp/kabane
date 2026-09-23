/**
 * Planner Sync — Backfill
 *
 * The properties that make a one-shot seed safe to run against a real planner:
 * FK-safe emission order, idempotence on re-run, and refusing to run at all
 * before the device has an identity to stamp ops with.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";

import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { Backfill } from "./backfill";

const DEVICE = "device-seed";
const NOW = "2026-08-03T12:00:00.000Z";

let base: string;

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

/** Ops in the log, in emission order. */
const oplog = () =>
	withDb((db) =>
		db
			.query<{ tbl: string; row_id: string; op: string }, []>(
				`SELECT tbl, row_id, op FROM ${TABLES.sync_oplog} ORDER BY seq ASC`,
			)
			.all(),
	);

const seedRows = () =>
	withDb((db) => {
		db.run(
			`INSERT INTO ${TABLES.projects} (id, title, state, created_at, updated_at)
       VALUES ('01PROJ', 'proj', 'active', ?, ?)`,
			[NOW, NOW],
		);
		// The subtask's id sorts BEFORE its parent's, so plain `ORDER BY id` would
		// emit the child first and the receiver's FK would reject it. Parent is
		// inserted first only because foreign_keys = ON requires it locally.
		for (const [id, parent] of [
			["01TASKZ", null],
			["01TASKA", "01TASKZ"],
		] as const) {
			db.run(
				`INSERT INTO ${TABLES.tasks}
           (id, title, kind, state, priority, source, discovered_at,
            parent_task_id, project_id, created_at, updated_at)
         VALUES (?, ?, 'task', 'inbox', 'normal', 'human', ?, ?, '01PROJ', ?, ?)`,
				[id, `task ${id}`, NOW, parent, NOW, NOW],
			);
		}
		db.run(
			`INSERT INTO ${TABLES.comments} (id, task_id, author, author_type, content, created_at)
       VALUES ('01CMT', '01TASKZ', 'me', 'human', 'hi', ?)`,
			[NOW],
		);
		// Excluded from SYNC_TABLES — must never be emitted.
		db.run(
			`INSERT INTO ${TABLES.short_id_history} (old_short_id, task_id, superseded_at)
       VALUES ('OLD-1', '01TASKZ', ?)`,
			[NOW],
		);
	});

beforeEach(async () => {
	base = join(tmpdir(), `planner-backfill-${crypto.randomUUID()}`);
	mkdirSync(base, { recursive: true });
	// DBInit caches per process: without a reset a second temp dir is skipped.

	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("Backfill.run", () => {
	it("refuses to run before the device is armed", async () => {
		await seedRows();
		const result = await Backfill.run(base);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("not armed");
		expect(await oplog()).toEqual([]);
	});

	it("emits FK parents before their children, and task roots before subtasks", async () => {
		await seedRows();
		await withDb((db) => {
			const armed = Oplog.initDevice(db, DEVICE);
			if (!armed.ok) throw armed.error;
		});

		const result = await Backfill.run(base);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const ops = await oplog();
		const order = ops.map((o) => `${o.tbl}:${o.row_id}`);

		// Every op is an insert; nothing else makes sense for a seed.
		expect(ops.every((o) => o.op === "insert")).toBe(true);

		// projects -> tasks -> task_comments, and the ROOT before its subtask even
		// though the subtask's id sorts first.
		expect(order.indexOf("projects:01PROJ")).toBeLessThan(
			order.indexOf("tasks:01TASKZ"),
		);
		expect(order.indexOf("tasks:01TASKZ")).toBeLessThan(
			order.indexOf("tasks:01TASKA"),
		);
		expect(order.indexOf("tasks:01TASKA")).toBeLessThan(
			order.indexOf("task_comments:01CMT"),
		);

		// An excluded table never reaches the log.
		expect(order.some((k) => k.startsWith("short_id_history:"))).toBe(false);

		expect(result.value.byTable.projects).toBe(1);
		expect(result.value.byTable.tasks).toBe(2);
		expect(result.value.byTable.task_comments).toBe(1);
		expect(result.value.written).toBe(4);
		expect(result.value.alreadyPresent).toBe(0);
	});

	it("is idempotent — a second run writes nothing and duplicates nothing", async () => {
		await seedRows();
		await withDb((db) => {
			const armed = Oplog.initDevice(db, DEVICE);
			if (!armed.ok) throw armed.error;
		});

		const first = await Backfill.run(base);
		expect(first.ok).toBe(true);
		const afterFirst = await oplog();

		const second = await Backfill.run(base);
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		expect(second.value.written).toBe(0);
		expect(second.value.alreadyPresent).toBe(afterFirst.length);
		// Re-running must not grow the log.
		expect(await oplog()).toEqual(afterFirst);
	});

	it("stamps row_updated_at from each table's own clock column", async () => {
		await seedRows();
		await withDb((db) => {
			const armed = Oplog.initDevice(db, DEVICE);
			if (!armed.ok) throw armed.error;
		});
		const done = await Backfill.run(base);
		expect(done.ok).toBe(true);

		const clocks = await withDb((db) =>
			db
				.query<{ tbl: string; row_updated_at: string | null }, []>(
					`SELECT tbl, row_updated_at FROM ${TABLES.sync_oplog} ORDER BY seq ASC`,
				)
				.all(),
		);

		const clockOf = (tbl: string) =>
			clocks.find((r) => r.tbl === tbl)?.row_updated_at;

		// A table with a clock column stamps it...
		expect(clockOf("projects")).toBe(NOW);
		expect(clockOf("tasks")).toBe(NOW);

		// ...but a NULL value in that column stays NULL rather than being
		// fabricated. An unedited comment has no `updated_at` — that is the real
		// shape, and inventing one would make it win an LWW compare it should lose.
		expect(clockOf("task_comments")).toBeNull();
	});

	it("skips private rows and keys each op on the row's version", async () => {
		await seedRows();
		await withDb((db) => {
			db.run(
				`UPDATE ${TABLES.tasks} SET visibility = 'private' WHERE id = '01TASKA'`,
			);
			db.run(`UPDATE ${TABLES.tasks} SET version = 4 WHERE id = '01TASKZ'`);
			const armed = Oplog.initDevice(db, DEVICE);
			if (!armed.ok) throw armed.error;
		});

		const result = await Backfill.run(base);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.skippedPrivate).toBe(1);
		expect(result.value.byTable.tasks).toBe(1);

		const ids = await withDb((db) =>
			db
				.query<{ op_id: string; row_id: string }, []>(
					`SELECT op_id, row_id FROM ${TABLES.sync_oplog} WHERE tbl = 'tasks'`,
				)
				.all(),
		);
		expect(ids).toEqual([{ op_id: "bf:tasks:01TASKZ:v4", row_id: "01TASKZ" }]);

		// An edit between runs is a new op, not an "already present" one.
		await withDb((db) =>
			db.run(`UPDATE ${TABLES.tasks} SET version = 5 WHERE id = '01TASKZ'`),
		);
		const again = await Backfill.run(base);
		expect(again.ok).toBe(true);
		if (again.ok) expect(again.value.byTable.tasks).toBe(1);
	});

	it("captures nothing itself — seeding does not re-enter the oplog", async () => {
		await seedRows();
		await withDb((db) => {
			const armed = Oplog.initDevice(db, DEVICE);
			if (!armed.ok) throw armed.error;
		});
		const done = await Backfill.run(base);
		expect(done.ok).toBe(true);
		if (!done.ok) return;

		// Writing ops directly must not trip the capture triggers, which would
		// double every row and grow without bound on each run.
		expect((await oplog()).length).toBe(done.value.written);
	});
});
