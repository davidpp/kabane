import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";

import { TABLES } from "./helpers";
import { Planner } from "./index";
import { type DrainedOp, Oplog } from "./oplog";

const DEVICE = "device-a";

/** Own temp dir per test — never a real JAKE_HOME. */
let base: string;

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

/** Arm capture by creating the singleton state row. */
const armCapture = async (): Promise<void> => {
	await withDb((db) => {
		const result = Oplog.initDevice(db, DEVICE);
		if (!result.ok) throw result.error;
	});
};

const drainOps = async (limit = 100): Promise<DrainedOp[]> =>
	withDb((db) => {
		const result = Oplog.drain(db, limit);
		if (!result.ok) throw result.error;
		return result.value;
	});

const createTask = async (title: string): Promise<string> => {
	const result = await Planner.addTask(base, { title });
	if (!result.ok) throw result.error;
	return result.value.id;
};

/** Every row in the oplog, regardless of the pushed watermark. */
const allOplogRows = async (): Promise<{ tbl: string; op: string }[]> =>
	withDb((db) =>
		db
			.query<{ tbl: string; op: string }, []>(
				`SELECT tbl, op FROM ${TABLES.sync_oplog} ORDER BY seq ASC`,
			)
			.all(),
	);

describe("Oplog — trigger-based capture", () => {
	beforeEach(async () => {
		base = join(tmpdir(), `planner-oplog-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });

		const init = await Planner.init(base);
		if (!init.ok) throw init.error;
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("captures insert, update and delete on a replicated table", async () => {
		await armCapture();

		const id = await createTask("captured");
		const updated = await Planner.updateTask(base, id, { title: "renamed" });
		expect(updated.ok).toBe(true);
		const deleted = await Planner.deleteTask(base, id);
		expect(deleted.ok).toBe(true);

		const ops = await drainOps();
		expect(ops.map((op) => op.op)).toEqual(["insert", "update", "delete"]);
		expect(ops.every((op) => op.tbl === "tasks")).toBe(true);
		expect(ops.every((op) => op.rowId === id)).toBe(true);
		expect(ops.every((op) => op.deviceId === DEVICE)).toBe(true);
		// op_id is the remote idempotency key — must be unique per op
		expect(new Set(ops.map((op) => op.opId)).size).toBe(3);
	});

	it("snapshots the full row on insert and update, nothing on delete", async () => {
		await armCapture();

		const id = await createTask("snapshot me");
		await Planner.updateTask(base, id, { title: "snapshot me twice" });
		await Planner.deleteTask(base, id);

		const [insert, update, remove] = await drainOps();

		expect(insert?.payload?.id).toBe(id);
		expect(insert?.payload?.title).toBe("snapshot me");
		// payload is keyed by DB column name, not the camelCase domain field
		expect(insert?.payload).toHaveProperty("scope_uri");
		expect(insert?.rowUpdatedAt).toBeString();

		expect(update?.payload?.title).toBe("snapshot me twice");

		expect(remove?.payload).toBeUndefined();
		expect(remove?.rowUpdatedAt).toBeUndefined();
	});

	it("omits rowUpdatedAt for a table with no updated_at column", async () => {
		await armCapture();
		const taskId = await createTask("has work log");

		const logged = await Planner.addWorkLog(base, {
			taskId,
			refs: [{ uri: "commit:abc123" }],
		});
		expect(logged.ok).toBe(true);

		const ops = await drainOps();
		const workLog = ops.find((op) => op.tbl === "task_work_log");
		expect(workLog).toBeDefined();
		expect(workLog?.rowUpdatedAt).toBeUndefined();
		// the snapshot is still captured — only the LWW clock is absent
		expect(workLog?.payload?.task_id).toBe(taskId);
	});

	it("captures nothing when the local sync_state row is absent", async () => {
		const id = await createTask("uncaptured");
		await Planner.updateTask(base, id, { title: "still uncaptured" });
		await Planner.deleteTask(base, id);

		expect(await allOplogRows()).toEqual([]);
	});

	it("captures nothing while the apply guard is raised", async () => {
		await armCapture();

		const guarded = await withDb((db) =>
			Oplog.withApplyGuard(db, () =>
				db.run(
					`INSERT INTO ${TABLES.projects} (id, title, state, created_at, updated_at)
             VALUES ('proj-guarded', 'Guarded', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				),
			),
		);
		expect(guarded.ok).toBe(true);

		expect(await allOplogRows()).toEqual([]);

		// the guard is lowered again, so the next write IS captured
		const after = await Planner.addProject(base, { title: "Unguarded" });
		expect(after.ok).toBe(true);
		const ops = await drainOps();
		expect(ops).toHaveLength(1);
		expect(ops[0]?.tbl).toBe("projects");
	});

	it("lowers the guard even when the guarded function throws", async () => {
		await armCapture();

		const failed = await withDb((db) =>
			Oplog.withApplyGuard(db, () => {
				throw new Error("apply blew up");
			}),
		);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.message).toBe("apply blew up");

		const state = await withDb((db) => Oplog.getState(db));
		expect(state.ok).toBe(true);
		if (state.ok) expect(state.value?.applyGuard).toBe(false);

		await createTask("captured after failure");
		expect(await drainOps()).toHaveLength(1);
	});

	it("drains FIFO by seq and skips ops the ack covered", async () => {
		await armCapture();

		await createTask("first");
		await createTask("second");
		await createTask("third");

		const ops = await drainOps();
		expect(ops).toHaveLength(3);
		expect(ops.map((op) => op.seq)).toEqual(
			[...ops.map((op) => op.seq)].sort((a, b) => a - b),
		);
		expect(ops.map((op) => op.payload?.title)).toEqual([
			"first",
			"second",
			"third",
		]);

		const throughSeq = ops[1]?.seq;
		expect(throughSeq).toBeNumber();
		if (throughSeq === undefined) return;

		await withDb((db) => {
			const acked = Oplog.ack(db, throughSeq);
			if (!acked.ok) throw acked.error;
		});

		const state = await withDb((db) => Oplog.getState(db));
		expect(state.ok).toBe(true);
		if (state.ok) expect(state.value?.lastPushedSeq).toBe(throughSeq);

		const remaining = await drainOps();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.payload?.title).toBe("third");
	});

	it("never moves the ack watermark backwards", async () => {
		await armCapture();
		await createTask("only");
		const ops = await drainOps();
		const seq = ops[0]?.seq ?? 0;

		await withDb((db) => {
			const forward = Oplog.ack(db, seq);
			if (!forward.ok) throw forward.error;
			const backward = Oplog.ack(db, 0);
			if (!backward.ok) throw backward.error;
		});

		const state = await withDb((db) => Oplog.getState(db));
		if (state.ok) expect(state.value?.lastPushedSeq).toBe(seq);
	});

	it("respects the drain limit", async () => {
		await armCapture();
		await createTask("a");
		await createTask("b");
		await createTask("c");

		expect(await drainOps(2)).toHaveLength(2);
	});

	it("drains nothing and does not error before initDevice", async () => {
		expect(await drainOps()).toEqual([]);

		const state = await withDb((db) => Oplog.getState(db));
		expect(state.ok).toBe(true);
		if (state.ok) expect(state.value).toBeUndefined();
	});

	it("keeps device identity write-once across repeated initDevice calls", async () => {
		await armCapture();
		await withDb((db) => {
			const again = Oplog.initDevice(db, "device-b");
			if (!again.ok) throw again.error;
		});

		const state = await withDb((db) => Oplog.getState(db));
		if (state.ok) expect(state.value?.deviceId).toBe(DEVICE);
	});

	it("produces no oplog rows for the FTS shadow tables", async () => {
		await armCapture();

		// addTask fires the tasks_fts insert trigger alongside capture
		await createTask("full text searchable");
		const comment = await Planner.addComment(base, {
			taskId: await createTask("commented"),
			author: "me",
			authorType: "human",
			content: "indexed by task_comments_fts",
		});
		expect(comment.ok).toBe(true);

		const rows = await allOplogRows();
		expect(rows.some((row) => row.tbl.includes("fts"))).toBe(false);
		expect(rows.map((row) => row.tbl).sort()).toEqual([
			"task_comments",
			"tasks",
			"tasks",
		]);
	});

	it("produces no oplog rows for excluded tables", async () => {
		await armCapture();
		const taskId = await createTask("has excluded children");
		const baseline = (await allOplogRows()).length;

		await withDb((db) => {
			db.run(
				`INSERT INTO ${TABLES.activity} (id, task_id, event_type, actor, actor_type, timestamp)
           VALUES ('act-1', ?, 'state_changed', 'me', 'human', '2026-01-01T00:00:00.000Z')`,
				[taskId],
			);
			db.run(
				`INSERT INTO ${TABLES.upstream_links}
           (id, task_id, provider, external_id, url, title, refreshed_at, created_at, updated_at)
         VALUES ('up-1', ?, 'linear', 'ENG-1', 'https://example.test/ENG-1', 'Upstream',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
				[taskId],
			);
		});

		expect(await allOplogRows()).toHaveLength(baseline);
	});

	it("installs a capture trigger per replicated table and op, idempotently", async () => {
		const triggerNames = async (): Promise<string[]> =>
			withDb((db) =>
				db
					.query<{ name: string }, []>(
						`SELECT name FROM sqlite_master
              WHERE type = 'trigger' AND name LIKE 'sync_cap_%'
              ORDER BY name`,
					)
					.all()
					.map((row) => row.name),
			);

		const first = await triggerNames();
		// 7 replicated tables x insert/update/delete
		expect(first).toHaveLength(21);
		expect(first).toContain("sync_cap_tasks_ins");
		expect(first).toContain("sync_cap_task_context_refs_del");

		// re-running writes nothing: every trigger already matches its column set
		const reinit = await withDb((db) => Oplog.ensureOplogTriggers(db));
		expect(reinit.ok).toBe(true);
		if (reinit.ok) expect(reinit.value).toBe(0);
		expect(await triggerNames()).toEqual(first);
	});

	it("rebuilds a stale trigger when a replicated table gains a column", async () => {
		await armCapture();

		// baseline: Planner.init already converged everything
		const clean = await withDb((db) => Oplog.ensureOplogTriggers(db));
		expect(clean.ok).toBe(true);
		if (clean.ok) expect(clean.value).toBe(0);

		await withDb((db) =>
			db.run(`ALTER TABLE ${TABLES.tasks} ADD COLUMN probe_col TEXT`),
		);

		// only the three tasks triggers are stale; the other six tables are untouched
		const healed = await withDb((db) => Oplog.ensureOplogTriggers(db));
		expect(healed.ok).toBe(true);
		if (healed.ok) expect(healed.value).toBe(3);

		const id = await createTask("after column add");
		await withDb((db) =>
			db.run(`UPDATE ${TABLES.tasks} SET probe_col = 'probed' WHERE id = ?`, [
				id,
			]),
		);

		const ops = await drainOps();
		const insert = ops.find((op) => op.op === "insert");
		const update = ops.find((op) => op.op === "update");
		// the new column is in the snapshot — this is the silent-data-loss case
		expect(insert?.payload).toHaveProperty("probe_col");
		expect(update?.payload?.probe_col).toBe("probed");

		// and it has converged: a further run writes nothing
		const settled = await withDb((db) => Oplog.ensureOplogTriggers(db));
		if (settled.ok) expect(settled.value).toBe(0);
	});

	it("rebuilds a trigger that was dropped out from under it", async () => {
		await withDb((db) => db.run("DROP TRIGGER sync_cap_tasks_upd"));

		const healed = await withDb((db) => Oplog.ensureOplogTriggers(db));
		expect(healed.ok).toBe(true);
		if (healed.ok) expect(healed.value).toBe(1);

		await armCapture();
		const id = await createTask("recreated trigger");
		await Planner.updateTask(base, id, { title: "captured again" });

		const ops = await drainOps();
		expect(ops.map((op) => op.op)).toEqual(["insert", "update"]);
	});
});
