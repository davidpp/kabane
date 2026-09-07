/**
 * Planner Sync — Convergence (the slice-1 acceptance gate)
 *
 * Two independent planner DBs in separate temp dirs, wired to ONE shared
 * in-process relay: two machines, zero cloud. Everything subtle about
 * replication is provable here — ordering, the capture guard, the resolution
 * rules, the rename protocol, FK safety — with no Worker, no D1, no wrangler and
 * no network.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";

import { SYNC_TABLES } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Oplog, physicalTableFor } from "../storage/oplog";
import { Apply } from "./apply";
import { LocalRelay, type Relay } from "./local-relay";
import { Sync } from "./namespace";
import type { PullPage, SyncTransport } from "./transport";

type Row = Record<string, unknown>;

type Device = {
	base: string;
	deviceId: string;
	transport: SyncTransport;
};

const ALPHA = "jake://scope/alpha";
const BETA = "jake://scope/beta";
const SHARED = "jake://scope/coll";

let relay: Relay;
let bases: string[];

// ============================================================
// Harness
// ============================================================

const withDb = async <T>(base: string, fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

/**
 * A fresh planner DB in its own temp dir, armed for capture and holding a
 * transport onto the shared relay.
 *
 * `DBInit.reset()` is load-bearing: the init flag is module-global, so without
 * it the SECOND device silently skips schema creation.
 */
const createDevice = async (deviceId: string): Promise<Device> => {
	const base = join(
		tmpdir(),
		`planner-sync-${deviceId}-${crypto.randomUUID()}`,
	);
	mkdirSync(base, { recursive: true });
	bases.push(base);

	const init = await Planner.init(base);
	if (!init.ok) throw init.error;

	await withDb(base, (db) => {
		const armed = Oplog.initDevice(db, deviceId);
		if (!armed.ok) throw armed.error;
	});

	return {
		base,
		deviceId,
		transport: LocalRelay.transportFor(relay, deviceId),
	};
};

const push = async (device: Device) => {
	const result = await Sync.push(device.base, device.transport);
	if (!result.ok) throw result.error;
	return result.value;
};

const pull = async (device: Device) => {
	const result = await Sync.pull(device.base, device.transport);
	if (!result.ok) throw result.error;
	return result.value;
};

/** One full bidirectional pass: both push, then both apply what the other sent. */
const converge = async (a: Device, b: Device) => {
	await push(a);
	await push(b);
	await pull(a);
	await pull(b);
};

const rowsOf = (base: string, physical: string): Promise<Row[]> =>
	withDb(base, (db) =>
		db.query<Row, []>(`SELECT * FROM ${physical} ORDER BY id`).all(),
	);

const countOf = async (base: string, physical: string): Promise<number> =>
	(await rowsOf(base, physical)).length;

const taskByTitle = async (base: string, title: string): Promise<Row> => {
	const row = await withDb(base, (db) =>
		db
			.query<Row, [string]>(`SELECT * FROM ${TABLES.tasks} WHERE title = ?`)
			.get(title),
	);
	if (!row) throw new Error(`No task titled "${title}" in ${base}`);
	return row;
};

const deleteOps = (base: string): Promise<{ tbl: string; seq: number }[]> =>
	withDb(base, (db) =>
		db
			.query<{ tbl: string; seq: number }, []>(
				`SELECT tbl, seq FROM ${TABLES.sync_oplog} WHERE op = 'delete' ORDER BY seq ASC`,
			)
			.all(),
	);

const addTask = async (
	device: Device,
	title: string,
	extra: Record<string, unknown> = {},
) => {
	const result = await Planner.addTask(device.base, { title, ...extra });
	if (!result.ok) throw result.error;
	return result.value;
};

// ============================================================
// Suite
// ============================================================

describe("Sync — two devices, one relay, no cloud", () => {
	beforeEach(() => {
		relay = LocalRelay.create();
		bases = [];
	});

	afterEach(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});

	it("converges every replicated table after concurrent offline work", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		// --- device A, offline: distinct scope so no short_id collides here ---
		const projectA = await Planner.addProject(a.base, {
			title: "Alpha project",
			scopeUri: ALPHA,
		});
		if (!projectA.ok) throw projectA.error;

		const a1 = await addTask(a, "A one", { scopeUri: ALPHA });
		const a2 = await addTask(a, "A two", {
			scopeUri: ALPHA,
			projectId: projectA.value.id,
		});
		const a3 = await addTask(a, "A subtask", {
			scopeUri: ALPHA,
			parentTaskId: a1.id,
		});
		expect(a3.id).toBeString();

		const linkA = await Planner.addLink(a.base, {
			sourceId: a1.id,
			targetId: a2.id,
			type: "blocks",
		});
		if (!linkA.ok) throw linkA.error;
		const commentA = await Planner.addComment(a.base, {
			taskId: a1.id,
			author: "david",
			authorType: "human",
			content: "from device A",
		});
		if (!commentA.ok) throw commentA.error;
		const workLogA = await Planner.addWorkLog(a.base, {
			taskId: a1.id,
			refs: [{ uri: "commit:aaa111" }],
		});
		if (!workLogA.ok) throw workLogA.error;
		const refA = await Planner.addContextRef(a.base, {
			taskId: a1.id,
			uri: "obsidian://prd-a",
			kind: "PRD",
		});
		if (!refA.ok) throw refA.error;
		const focusA = await Planner.saveFocusList(a.base, {
			period: "daily",
			items: [{ taskId: a1.id, order: 0, completed: false }],
		});
		if (!focusA.ok) throw focusA.error;
		const bumped = await Planner.updateTask(a.base, a1.id, {
			priority: "high",
		});
		if (!bumped.ok) throw bumped.error;

		// --- device B, offline ---
		const projectB = await Planner.addProject(b.base, {
			title: "Beta project",
			scopeUri: BETA,
		});
		if (!projectB.ok) throw projectB.error;

		const b1 = await addTask(b, "B one", { scopeUri: BETA });
		const b2 = await addTask(b, "B two", {
			scopeUri: BETA,
			projectId: projectB.value.id,
		});

		const linkB = await Planner.addLink(b.base, {
			sourceId: b1.id,
			targetId: b2.id,
			type: "related",
		});
		if (!linkB.ok) throw linkB.error;
		const commentB = await Planner.addComment(b.base, {
			taskId: b2.id,
			author: "claude",
			authorType: "ai",
			content: "from device B",
		});
		if (!commentB.ok) throw commentB.error;
		const workLogB = await Planner.addWorkLog(b.base, {
			taskId: b2.id,
			refs: [{ uri: "commit:bbb222" }],
		});
		if (!workLogB.ok) throw workLogB.error;
		const refB = await Planner.addContextRef(b.base, {
			taskId: b2.id,
			uri: "obsidian://prd-b",
			kind: "PRD",
		});
		if (!refB.ok) throw refB.error;
		const focusB = await Planner.saveFocusList(b.base, {
			period: "weekly",
			items: [{ taskId: b1.id, order: 0, completed: false }],
		});
		if (!focusB.ok) throw focusB.error;

		await converge(a, b);

		// Every replicated table, row for row, both directions.
		for (const table of SYNC_TABLES) {
			const physical = physicalTableFor(table);
			const onA = await rowsOf(a.base, physical);
			const onB = await rowsOf(b.base, physical);
			expect(
				onA.length,
				`${table} is empty — the test proves nothing`,
			).toBeGreaterThan(0);
			expect(onB, `${table} diverged`).toEqual(onA);
		}

		// Sanity on the shape, not just the equality.
		expect(await countOf(a.base, TABLES.tasks)).toBe(5);
		expect(await countOf(b.base, TABLES.projects)).toBe(2);
		expect((await taskByTitle(b.base, "A one")).priority).toBe("high");
		expect((await taskByTitle(a.base, "B two")).project_id).toBe(
			projectB.value.id,
		);
	});

	it("keeps both tasks when two devices mint the same short_id offline", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		// Same scope on both machines, and both counters start at 1, so both mint
		// the identical label. 2ms apart so the ULID order is not a coin flip.
		const winner = await addTask(a, "A collides", { scopeUri: SHARED });
		await Bun.sleep(2);
		const loser = await addTask(b, "B collides", { scopeUri: SHARED });

		expect(winner.shortId).toBe(loser.shortId);
		expect(winner.id < loser.id).toBe(true);

		await converge(a, b);

		for (const device of [a, b]) {
			const tasks = await rowsOf(device.base, TABLES.tasks);
			expect(tasks, `${device.deviceId} lost a task`).toHaveLength(2);

			const kept = tasks.find((task) => task.id === winner.id);
			const renamed = tasks.find((task) => task.id === loser.id);
			// The ULID-earlier row keeps the label; both devices pick the same one.
			expect(kept?.short_id).toBe(winner.shortId);
			expect(renamed?.short_id).not.toBe(winner.shortId);
			expect(renamed?.short_id).toBeString();

			const history = await withDb(device.base, (db) =>
				db
					.query<{ old_short_id: string; task_id: string }, []>(
						`SELECT old_short_id, task_id FROM ${TABLES.short_id_history}`,
					)
					.all(),
			);
			expect(history).toEqual([
				{ old_short_id: winner.shortId ?? "", task_id: loser.id },
			]);

			// The audit trail cannot be looked up (the winner keeps the label live),
			// so the rename has to be visible on the task itself.
			const activity = await withDb(device.base, (db) =>
				db
					.query<Row, [string]>(
						`SELECT * FROM ${TABLES.activity} WHERE task_id = ?`,
					)
					.all(loser.id),
			);
			expect(activity).toHaveLength(1);
			expect(activity[0]?.event_type).toBe("short_id_renamed");
			expect(activity[0]?.old_value).toBe(winner.shortId);
			expect(activity[0]?.new_value).toBe(renamed?.short_id);
		}

		// Both devices minted the SAME replacement label: the mint is derived from
		// the labels in the batch plus the local table, not from a machine-local
		// counter, so the two sides agree without exchanging the rename.
		expect((await taskByTitle(b.base, "B collides")).short_id).toBe(
			(await taskByTitle(a.base, "B collides")).short_id,
		);
	});

	it("heals a rename the two devices minted differently from partial logs", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const winner = await addTask(a, "A wins", { scopeUri: SHARED });
		// Three more labels in the same family that A has NOT shipped yet, so the
		// two devices are looking at different halves of the log when they rename.
		for (const title of ["a2", "a3", "a4"]) {
			await addTask(a, title, { scopeUri: SHARED });
		}
		await Bun.sleep(2);
		const loser = await addTask(b, "B loses", { scopeUri: SHARED });

		// A ships only the colliding op.
		const partial = await Sync.push(a.base, a.transport, {
			limit: 1,
			maxBatches: 1,
		});
		if (!partial.ok) throw partial.error;
		await push(b);
		await pull(a);
		await pull(b);

		const labelOf = async (device: Device) =>
			(await taskByTitle(device.base, "B loses")).short_id;

		// They disagree: each minted past the labels IT could see.
		expect(await labelOf(a)).not.toBe(await labelOf(b));

		// A full pass delivers the withheld labels, which collide with B's guess and
		// rename it again — this time off the complete label set, so both devices
		// land on the same label. The divergence is transient, not permanent. The
		// second pass asserts it settles instead of oscillating.
		await converge(a, b);
		await converge(a, b);

		expect(await labelOf(b)).toBe(await labelOf(a));
		expect(await rowsOf(b.base, TABLES.tasks)).toEqual(
			await rowsOf(a.base, TABLES.tasks),
		);
		expect((await taskByTitle(a.base, "A wins")).short_id).toBe(winner.shortId);
		expect((await taskByTitle(a.base, "B loses")).id).toBe(loser.id);
	});

	it("merges focus_lists items instead of overwriting the period", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const a1 = await addTask(a, "A focus", { scopeUri: ALPHA });
		const b1 = await addTask(b, "B focus", { scopeUri: BETA });

		const savedA = await Planner.saveFocusList(a.base, {
			period: "daily",
			items: [{ taskId: a1.id, order: 0, completed: false }],
		});
		if (!savedA.ok) throw savedA.error;
		const savedB = await Planner.saveFocusList(b.base, {
			period: "daily",
			items: [{ taskId: b1.id, order: 1, completed: false }],
		});
		if (!savedB.ok) throw savedB.error;

		await converge(a, b);

		const survivingId =
			savedA.value.id < savedB.value.id ? savedA.value.id : savedB.value.id;

		for (const device of [a, b]) {
			const lists = await rowsOf(device.base, TABLES.focus_lists);
			expect(lists, `${device.deviceId} has a duplicate period`).toHaveLength(
				1,
			);
			// Lowest ULID owns the row — UNIQUE(period) allows exactly one.
			expect(lists[0]?.id).toBe(survivingId);

			const items = JSON.parse(String(lists[0]?.items)) as { taskId: string }[];
			expect(items.map((item) => item.taskId).sort()).toEqual(
				[a1.id, b1.id].sort(),
			);
		}
	});

	it("captures a cascade as children-before-parent and replays it FK-safely", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const parent = await addTask(a, "doomed", { scopeUri: ALPHA });
		const sibling = await addTask(a, "survivor", { scopeUri: ALPHA });
		for (const content of ["first", "second"]) {
			const comment = await Planner.addComment(a.base, {
				taskId: parent.id,
				author: "david",
				authorType: "human",
				content,
			});
			if (!comment.ok) throw comment.error;
		}
		const log = await Planner.addWorkLog(a.base, {
			taskId: parent.id,
			refs: [{ uri: "commit:ccc333" }],
		});
		if (!log.ok) throw log.error;
		const ref = await Planner.addContextRef(a.base, {
			taskId: parent.id,
			uri: "obsidian://doomed",
			kind: "PRD",
		});
		if (!ref.ok) throw ref.error;
		const link = await Planner.addLink(a.base, {
			sourceId: parent.id,
			targetId: sibling.id,
			type: "blocks",
		});
		if (!link.ok) throw link.error;

		await converge(a, b);
		expect(await countOf(b.base, TABLES.comments)).toBe(2);

		const removed = await Planner.deleteTask(a.base, parent.id);
		if (!removed.ok) throw removed.error;

		// The storage layer snapshots the cascade before the DELETE and captures
		// it children first: 1 + N ops.
		const deletes = await deleteOps(a.base);
		expect(deletes).toHaveLength(6);
		expect(deletes[deletes.length - 1]?.tbl).toBe("tasks");
		expect(
			deletes
				.slice(0, -1)
				.map((op) => op.tbl)
				.sort(),
		).toEqual([
			"task_comments",
			"task_comments",
			"task_context_refs",
			"task_links",
			"task_work_log",
		]);

		await push(a);
		const report = await pull(b);

		// Applying in seq order deletes children first, so the FK holds at every
		// step and nothing had to be skipped as already-absent.
		expect(report.applied).toBe(6);
		expect(report.skipped["already-absent"]).toBe(0);

		for (const device of [a, b]) {
			expect(await countOf(device.base, TABLES.comments)).toBe(0);
			expect(await countOf(device.base, TABLES.work_log)).toBe(0);
			expect(await countOf(device.base, TABLES.context_refs)).toBe(0);
			expect(await countOf(device.base, TABLES.task_links)).toBe(0);
			expect(await countOf(device.base, TABLES.tasks)).toBe(1);
		}
	});

	it("pre-filters an FK orphan without taking its batch down", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const doomed = await addTask(a, "deleted on A", { scopeUri: ALPHA });
		const survivor = await addTask(a, "edited on B", { scopeUri: ALPHA });
		await converge(a, b);

		// A deletes the parent and pushes FIRST, so the delete sits earlier in the
		// log than B's insert.
		const removed = await Planner.deleteTask(a.base, doomed.id);
		if (!removed.ok) throw removed.error;
		await push(a);

		// B, not yet aware, comments on the doomed task and makes one legitimate
		// edit that MUST survive the same batch.
		const orphan = await Planner.addComment(b.base, {
			taskId: doomed.id,
			author: "david",
			authorType: "human",
			content: "written on a task A already deleted",
		});
		if (!orphan.ok) throw orphan.error;
		const edited = await Planner.updateTask(b.base, survivor.id, {
			title: "edited on B, must land",
		});
		if (!edited.ok) throw edited.error;
		await push(b);

		const report = await pull(a);

		// Pre-filtered, not caught: an issued INSERT would have rolled the whole
		// transaction back, sibling UPDATE included.
		expect(report.skipped["orphan-parent"]).toBe(1);
		expect(report.applied).toBe(1);
		expect(await countOf(a.base, TABLES.comments)).toBe(0);
		expect((await taskByTitle(a.base, "edited on B, must land")).id).toBe(
			survivor.id,
		);

		// And B converges the other way: applying A's delete cascades its own
		// comment away, so neither device keeps the orphan.
		await pull(b);
		expect(await countOf(b.base, TABLES.comments)).toBe(0);
		expect(await countOf(b.base, TABLES.tasks)).toBe(1);
	});

	it("converges three devices on one winner when two authors edit at the same millisecond", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");
		const c = await createDevice("device-c");
		const all = [a, b, c];
		const convergeAll = async () => {
			for (const d of all) await push(d);
			for (const d of all) await pull(d);
			// A second round so every device has also seen what the others pulled.
			for (const d of all) await push(d);
			for (const d of all) await pull(d);
		};

		const task = await addTask(a, "contested", { scopeUri: ALPHA });
		await convergeAll();
		for (const d of all) expect(await countOf(d.base, TABLES.tasks)).toBe(1);

		// Same millisecond, same version bump, two different authors. Written
		// through raw SQL so the clock is byte-identical (and later than the
		// creation clock), then captured through the same step the storage layer
		// uses.
		const TIE = "2099-01-01T00:00:00.000Z";
		const edit = (device: Device, actor: string, title: string) =>
			withDb(device.base, (db) => {
				db.run(
					`UPDATE ${TABLES.tasks}
              SET title = ?, updated_at = ?, version = version + 1, updated_by = ?
            WHERE id = ?`,
					[title, TIE, actor, task.id],
				);
				const captured = Oplog.captureRow(db, "tasks", "update", task.id);
				if (!captured.ok) throw captured.error;
			});
		await edit(a, "cabane://actor/agent/hermes", "written by hermes");
		await edit(b, "cabane://actor/agent/claude", "written by claude");

		await convergeAll();

		// Equal clock, equal version: the lower actor URI wins everywhere —
		// including on C, which authored nothing and would previously have
		// compared both rows as if it had written the one it held.
		for (const d of all) {
			const row = await taskByTitle(d.base, "written by claude");
			expect(row.id).toBe(task.id);
			expect(row.version).toBe(2);
			expect(await countOf(d.base, TABLES.tasks)).toBe(1);
		}

		// The loser recorded the overwrite of its own lineage on the task.
		const conflictsOnA = await withDb(a.base, (db) =>
			db
				.query<{ old_value: string; new_value: string }, [string]>(
					`SELECT old_value, new_value FROM ${TABLES.activity}
            WHERE task_id = ? AND event_type = 'sync_conflict_resolved'`,
				)
				.all(task.id),
		);
		expect(conflictsOnA).toEqual([{ old_value: "2", new_value: "2" }]);
	});

	it("is idempotent: re-applying a page duplicates nothing and re-captures nothing", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const task = await addTask(a, "applied twice", { scopeUri: ALPHA });
		const comment = await Planner.addComment(a.base, {
			taskId: task.id,
			author: "david",
			authorType: "human",
			content: "once",
		});
		if (!comment.ok) throw comment.error;
		await push(a);

		// B has unpushed work of its own — the guard must not swallow it.
		await addTask(b, "B local, unpushed", { scopeUri: BETA });
		const before = await Sync.status(b.base);
		if (!before.ok) throw before.error;
		expect(before.value.pendingOps).toBe(1);

		const page = await b.transport.pull(0, 500);
		if (!page.ok) throw page.error;
		const batch: PullPage = page.value;
		expect(batch.ops.length).toBeGreaterThan(0);

		const first = await Apply.applyBatch(b.base, batch);
		if (!first.ok) throw first.error;
		const afterFirst = {
			tasks: await rowsOf(b.base, TABLES.tasks),
			comments: await rowsOf(b.base, TABLES.comments),
		};

		const second = await Apply.applyBatch(b.base, batch);
		if (!second.ok) throw second.error;

		expect(await rowsOf(b.base, TABLES.tasks)).toEqual(afterFirst.tasks);
		expect(await rowsOf(b.base, TABLES.comments)).toEqual(afterFirst.comments);
		// Append-only rows are recognized rather than re-inserted.
		expect(second.value.skipped["already-present"]).toBeGreaterThan(0);

		// Apply writes below the capture step: not a single op was recorded.
		const after = await Sync.status(b.base);
		if (!after.ok) throw after.error;
		expect(after.value.pendingOps).toBe(1);
		expect(after.value.lastAppliedSeq).toBe(batch.throughSeq);
	});
});
