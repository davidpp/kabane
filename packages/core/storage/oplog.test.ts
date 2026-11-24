import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";
import { configureTestRuntime } from "../testing";
import { TABLES } from "./helpers";
import { Planner } from "./index";
import { type DrainedOp, Oplog } from "./oplog";

const DEVICE = "device-a";

/** Own temp dir per test — never a real KABANE_HOME. */
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

describe("Oplog — storage-layer capture", () => {
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

		// A thread is never hard-deleted: its delete is a tombstone, an update.
		const ops = (await drainOps()).filter((op) => op.tbl === "threads");
		expect(ops.map((op) => op.op)).toEqual(["insert", "update", "update"]);
		expect(ops.every((op) => op.rowId === id)).toBe(true);
		expect(ops.every((op) => op.deviceId === DEVICE)).toBe(true);
		expect(ops[2]?.payload?.deleted_at).toBeString();
		// op_id is the remote idempotency key — must be unique per op
		expect(new Set(ops.map((op) => op.opId)).size).toBe(3);
	});

	it("snapshots the full row on insert and update, nothing on delete", async () => {
		await armCapture();

		const id = await createTask("snapshot me");
		await Planner.updateTask(base, id, { title: "snapshot me twice" });
		await Planner.deleteTask(base, id);

		const [insert, update, remove] = (await drainOps()).filter(
			(op) => op.tbl === "threads",
		);

		expect(insert?.payload?.id).toBe(id);
		expect(insert?.payload?.title).toBe("snapshot me");
		// payload is keyed by DB column name, not the camelCase domain field
		expect(insert?.payload).toHaveProperty("state_updated_at");
		expect(insert?.rowUpdatedAt).toBeString();

		expect(update?.payload?.title).toBe("snapshot me twice");

		expect(remove?.payload?.title).toBe("snapshot me twice");
		expect(remove?.payload?.deleted_at).toBeString();
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
		const workLog = ops.find((op) => op.tbl === "entries");
		expect(workLog).toBeDefined();
		expect(workLog?.rowUpdatedAt).toBeUndefined();
		// the snapshot is still captured — only the LWW clock is absent
		expect(workLog?.payload?.thread_id).toBe(taskId);
		expect(workLog?.payload?.kind).toBe("log");
	});

	it("captures nothing when the local sync_state row is absent", async () => {
		const id = await createTask("uncaptured");
		await Planner.updateTask(base, id, { title: "still uncaptured" });
		await Planner.deleteTask(base, id);

		expect(await allOplogRows()).toEqual([]);
	});

	it("drains FIFO by seq and skips ops the ack covered", async () => {
		await armCapture();

		await createTask("first");
		await createTask("second");
		await createTask("third");

		const ops = (await drainOps()).filter((op) => op.tbl === "threads");
		expect(ops).toHaveLength(3);
		expect(ops.map((op) => op.seq)).toEqual(
			ops.map((op) => op.seq).sort((a, b) => a - b),
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

		const remaining = (await drainOps()).filter((op) => op.tbl === "threads");
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
		// nothing but the storage layer writes ops now, so there is no trigger
		// left for the FTS shadow tables to fire
		expect([...new Set(rows.map((row) => row.tbl))].sort()).toEqual([
			"attributes",
			"entries",
			"threads",
		]);
	});

	it("produces no oplog rows for excluded tables", async () => {
		await armCapture();
		const taskId = await createTask("has excluded children");
		const baseline = (await allOplogRows()).length;

		await withDb((db) => {
			db.run(
				`INSERT INTO ${TABLES.short_id_history} (old_short_id, task_id, superseded_at)
           VALUES ('OLD-1', ?, '2026-01-01T00:00:00.000Z')`,
				[taskId],
			);
		});

		expect(await allOplogRows()).toHaveLength(baseline);
	});

	it("captures a linked issue through link and unlink", async () => {
		await armCapture();
		const taskId = await createTask("has a team-facing twin");
		await drainOps();

		const linked = await Planner.upsertUpstreamLink(base, {
			taskId,
			provider: "linear",
			externalId: "linear-uuid",
			identifier: "ENG-123",
			url: "https://linear.app/acme/issue/ENG-123/x",
			title: "Team feature",
		});
		if (!linked.ok) throw linked.error;
		await Planner.upsertUpstreamLink(base, {
			taskId,
			provider: "linear",
			externalId: "linear-uuid",
			identifier: "ENG-123",
			url: "https://linear.app/acme/issue/ENG-123/x",
			title: "Team feature, retitled",
		});
		await Planner.deleteUpstreamLink(base, linked.value.id);

		// An unlink is a removal written as an update.
		const rows = await allOplogRows();
		expect(rows.filter((row) => row.tbl === "refs")).toEqual([
			{ tbl: "refs", op: "insert" },
			{ tbl: "refs", op: "update" },
			{ tbl: "refs", op: "update" },
		]);
	});

	it("stamps updated_by from the actor port and bumps version on every update", async () => {
		configureTestRuntime({ actor: () => "kabane://actor/human/tester" });
		await armCapture();

		const id = await createTask("versioned");
		await Planner.updateTask(base, id, { title: "v2" });
		await Planner.updateTask(base, id, { title: "v3" });

		const ops = (await drainOps()).filter((op) => op.tbl === "threads");
		expect(ops.map((op) => op.version)).toEqual([1, 2, 3]);
		expect(
			ops.every((op) => op.updatedBy === "kabane://actor/human/tester"),
		).toBe(true);
		expect(ops[2]?.payload?.updated_by).toBe("kabane://actor/human/tester");
		configureTestRuntime();
	});

	it("keeps a private row out of the log through insert, update and delete", async () => {
		await armCapture();
		const id = await createTask("shared then private");
		const created = (await allOplogRows()).length;

		await withDb((db) =>
			db.run(
				`UPDATE ${TABLES.threads} SET visibility = 'private' WHERE id = ?`,
				[id],
			),
		);
		await Planner.updateTask(base, id, { title: "edited while private" });
		await Planner.deleteTask(base, id);

		// the ops from before the row went private are all there is
		expect(await allOplogRows()).toHaveLength(created);
	});

	it("captures a task delete as one tombstone: what sits under it reads as gone", async () => {
		await armCapture();
		const parent = await createTask("parent");
		const child = await Planner.addTask(base, {
			title: "subtask",
			parentTaskId: parent,
		});
		if (!child.ok) throw child.error;
		await Planner.addComment(base, {
			taskId: child.value.id,
			author: "me",
			authorType: "human",
			content: "on subtask",
		});
		const before = (await allOplogRows()).length;

		const deleted = await Planner.deleteTask(base, parent);
		expect(deleted.ok).toBe(true);

		expect((await allOplogRows()).slice(before)).toEqual([
			{ tbl: "threads", op: "update" },
		]);
		const gone = await Planner.getTask(base, child.value.id);
		expect(gone.ok && gone.value).toBeNull();
		const comments = await Planner.getComments(base, child.value.id);
		expect(comments.ok && comments.value).toEqual([]);
	});

	it("captures the project_id clear on every task a deleted project owned", async () => {
		await armCapture();
		const project = await Planner.addProject(base, { title: "doomed" });
		if (!project.ok) throw project.error;
		const owned = await Planner.addTask(base, {
			title: "owned",
			projectId: project.value.id,
		});
		if (!owned.ok) throw owned.error;
		const before = (await allOplogRows()).length;

		const removed = await Planner.deleteProject(base, project.value.id);
		expect(removed.ok).toBe(true);

		const ops = (await drainOps()).slice(before);
		expect(ops.map((op) => `${op.tbl}:${op.op}`)).toEqual([
			"attributes:update",
			"projects:delete",
		]);
		expect(ops[0]?.payload?.key).toBe("project_id");
		expect(ops[0]?.payload?.removed_at).toBeString();
		expect(ops[0]?.version).toBe(2);
	});
});
