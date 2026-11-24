/**
 * Planner Sync — Convergence (the slice-1 acceptance gate)
 *
 * Two independent planner DBs in separate temp dirs, wired to ONE shared
 * in-process relay: two machines, zero cloud. Everything subtle about
 * replication is provable here — ordering, the capture guard, the resolution
 * rules, and the storage layer as the record's real writer — with no Worker, no
 * D1, no wrangler and no network.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";

import { Replicated } from "../replicated";
import { isRecordTable, RECORD_KEYS } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
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

const ALPHA = "kabane://scope/alpha";
const BETA = "kabane://scope/beta";
const SHARED = "kabane://scope/coll";

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
		db
			.query<Row, []>(
				`SELECT * FROM ${physical} ORDER BY ${isRecordTable(physical) ? RECORD_KEYS[physical].join(", ") : "id"}`,
			)
			.all(),
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
		const upstreamA = await Planner.upsertUpstreamLink(a.base, {
			taskId: a1.id,
			provider: "linear",
			externalId: "linear-a",
			identifier: "ENG-1",
			url: "https://linear.app/acme/issue/ENG-1/a",
			title: "Team feature A",
		});
		if (!upstreamA.ok) throw upstreamA.error;
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
		const upstreamB = await Planner.upsertUpstreamLink(b.base, {
			taskId: b2.id,
			provider: "github",
			externalId: "github-b",
			identifier: "davidpp/kabane#12",
			url: "https://github.com/davidpp/kabane/issues/12",
			title: "Team feature B",
		});
		if (!upstreamB.ok) throw upstreamB.error;

		await converge(a, b);

		// Every replicated table, row for row, both directions.
		for (const table of Replicated.CORE_TABLES) {
			const onA = await rowsOf(a.base, table);
			const onB = await rowsOf(b.base, table);
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

	it("replicates an entry's kind, both ways", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");
		const task = await addTask(a, "Timeline", { scopeUri: ALPHA });
		await converge(a, b);

		const review = await Planner.addEntry(a.base, {
			taskId: task.id,
			kind: "review",
			author: "kabane://actor/agent/claude",
			authorType: "ai",
			content: "from device A",
		});
		if (!review.ok) throw review.error;
		const handoff = await Planner.addEntry(b.base, {
			taskId: task.id,
			kind: "handoff.summary",
			author: "kabane://actor/agent/codex",
			authorType: "ai",
			content: "from device B",
		});
		if (!handoff.ok) throw handoff.error;
		await converge(a, b);

		for (const device of [a, b]) {
			const entries = await Planner.getEntries(device.base, task.id);
			if (!entries.ok) throw entries.error;
			expect(
				entries.value.map((e) => [e.id, e.kind]).sort(),
				device.deviceId,
			).toEqual(
				[
					[review.value.id, "review"],
					[handoff.value.id, "handoff.summary"],
				].sort(),
			);
		}
		expect(await rowsOf(b.base, TABLES.entries)).toEqual(
			await rowsOf(a.base, TABLES.entries),
		);
	});

	it("keeps both threads when two devices mint the same short_id offline, under that one label", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		// Same scope on both machines, and both counters start at 1, so both mint
		// the identical label.
		const first = await addTask(a, "A collides", { scopeUri: SHARED });
		const second = await addTask(b, "B collides", { scopeUri: SHARED });
		expect(first.shortId).toBe(second.shortId);

		await converge(a, b);

		// No rename on the record yet (JCAB-660): both threads keep the label,
		// and the two devices store the same rows.
		for (const device of [a, b]) {
			const tasks = await rowsOf(device.base, TABLES.tasks);
			expect(tasks, `${device.deviceId} lost a task`).toHaveLength(2);
			expect(tasks.map((task) => task.short_id)).toEqual([
				first.shortId,
				first.shortId,
			]);
		}
		expect(await rowsOf(b.base, TABLES.threads)).toEqual(
			await rowsOf(a.base, TABLES.threads),
		);
	});

	it("raises a device's counter past the labels its pulled threads hold", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");
		for (const title of ["one", "two", "three"])
			await addTask(a, title, { scopeUri: SHARED });
		await converge(a, b);

		// B has minted nothing in this scope; its next label follows A's.
		const minted = await addTask(b, "four", { scopeUri: SHARED });
		const held = (await rowsOf(b.base, TABLES.threads)).map((t) => t.short_id);
		expect(held.filter((label) => label === minted.shortId)).toHaveLength(1);
		expect(minted.shortId).toBe("JCOL-4");
	});

	it("replicates a delete as one tombstone that hides the thread and what it holds", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const parent = await addTask(a, "doomed", { scopeUri: ALPHA });
		const sibling = await addTask(a, "survivor", { scopeUri: ALPHA });
		const child = await addTask(a, "doomed child", {
			scopeUri: ALPHA,
			parentTaskId: parent.id,
		});
		for (const content of ["first", "second"]) {
			const comment = await Planner.addComment(a.base, {
				taskId: parent.id,
				author: "david",
				authorType: "human",
				content,
			});
			if (!comment.ok) throw comment.error;
		}
		const link = await Planner.addLink(a.base, {
			sourceId: sibling.id,
			targetId: parent.id,
			type: "blocks",
		});
		if (!link.ok) throw link.error;

		await converge(a, b);
		const comments = await Planner.getComments(b.base, parent.id);
		expect(comments.ok && comments.value).toHaveLength(2);

		const removed = await Planner.deleteTask(a.base, parent.id);
		if (!removed.ok) throw removed.error;
		expect(await deleteOps(a.base)).toEqual([]);

		await push(a);
		const report = await pull(b);
		expect(report.applied).toBe(1);

		for (const device of [a, b]) {
			const tasks = await rowsOf(device.base, TABLES.tasks);
			expect(tasks.map((task) => task.title)).toEqual(["survivor"]);
			const gone = await Planner.getComments(device.base, parent.id);
			expect(gone.ok && gone.value).toEqual([]);
			const links = await Planner.getLinksForTask(device.base, sibling.id);
			expect(links.ok && links.value).toEqual([]);
			const under = await Planner.getTask(device.base, child.id);
			expect(under.ok && under.value).toBeNull();
			// Stored, never shown: a delete is final and nothing is dropped.
			expect(await countOf(device.base, TABLES.entries)).toBe(2);
		}
		expect(await rowsOf(b.base, TABLES.threads)).toEqual(
			await rowsOf(a.base, TABLES.threads),
		);
	});

	it("stores an entry written on a thread another device deleted, and shows it nowhere", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		const doomed = await addTask(a, "deleted on A", { scopeUri: ALPHA });
		const survivor = await addTask(a, "edited on B", { scopeUri: ALPHA });
		await converge(a, b);

		const removed = await Planner.deleteTask(a.base, doomed.id);
		if (!removed.ok) throw removed.error;
		await push(a);

		// B, not yet aware, comments on the doomed task and makes one edit.
		const late = await Planner.addComment(b.base, {
			taskId: doomed.id,
			author: "david",
			authorType: "human",
			content: "written on a task A already deleted",
		});
		if (!late.ok) throw late.error;
		const edited = await Planner.updateTask(b.base, survivor.id, {
			title: "edited on B, must land",
		});
		if (!edited.ok) throw edited.error;
		await push(b);

		const report = await pull(a);
		expect(report.skipped["orphan-parent"]).toBe(0);
		expect(report.applied).toBe(2);
		expect((await taskByTitle(a.base, "edited on B, must land")).id).toBe(
			survivor.id,
		);

		await pull(b);
		for (const device of [a, b]) {
			const comments = await Planner.getComments(device.base, doomed.id);
			expect(comments.ok && comments.value).toEqual([]);
			expect(await countOf(device.base, TABLES.tasks)).toBe(1);
		}
		expect(await rowsOf(b.base, TABLES.entries)).toEqual(
			await rowsOf(a.base, TABLES.entries),
		);
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

		// Same millisecond, same counter, two different devices. Written through
		// raw SQL so the clock is byte-identical (and later than the creation
		// clock), stamped as a writer stamps, then captured through the same step
		// the storage layer uses.
		const TIE = "2099-01-01T00:00:00.000Z";
		const edit = (device: Device, actor: string, title: string) =>
			withDb(device.base, (db) => {
				db.run(
					`UPDATE ${TABLES.threads}
              SET title = ?, updated_at = ?, version = version + 1, updated_by = ?,
                  updated_device = ?
            WHERE id = ?`,
					[title, TIE, actor, device.deviceId, task.id],
				);
				Oplog.afterWrite(db, TABLES.threads, "update", task.id);
			});
		await edit(a, "kabane://actor/agent/hermes", "written by hermes");
		await edit(b, "kabane://actor/agent/claude", "written by claude");

		await convergeAll();

		// Equal clock, equal counter: the greater writing device wins everywhere —
		// including on C, which authored nothing (`sync/resolve.ts`, "The 2.0
		// record").
		for (const d of all) {
			const row = await taskByTitle(d.base, "written by claude");
			expect(row.id).toBe(task.id);
			expect(row.version).toBe(2);
			expect(await countOf(d.base, TABLES.tasks)).toBe(1);
		}
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
		const pending = before.value.pendingOps;
		expect(pending).toBeGreaterThan(0);

		const page = await b.transport.pull(0, 500);
		if (!page.ok) throw page.error;
		const batch: PullPage = page.value;
		expect(batch.ops.length).toBeGreaterThan(0);

		const first = await Apply.applyBatch(b.base, batch);
		if (!first.ok) throw first.error;
		const afterFirst = {
			threads: await rowsOf(b.base, TABLES.threads),
			entries: await rowsOf(b.base, TABLES.entries),
		};

		const second = await Apply.applyBatch(b.base, batch);
		if (!second.ok) throw second.error;

		expect(await rowsOf(b.base, TABLES.threads)).toEqual(afterFirst.threads);
		expect(await rowsOf(b.base, TABLES.entries)).toEqual(afterFirst.entries);
		// A record row already held wins every register: nothing is written again.
		expect(second.value.applied).toBe(0);

		// Apply writes below the capture step: not a single op was recorded.
		const after = await Sync.status(b.base);
		if (!after.ok) throw after.error;
		expect(after.value.pendingOps).toBe(pending);
		expect(after.value.lastAppliedSeq).toBe(batch.throughSeq);
	});

	it("dedupes the same task linked to the same issue on two devices", async () => {
		const a = await createDevice("device-a");
		const b = await createDevice("device-b");

		// One task both devices already agree on.
		const task = await addTask(a, "linked twice", { scopeUri: ALPHA });
		await converge(a, b);

		// Then, offline, each device links it to the SAME external issue. The
		// ref's key is the thread, the provider's id and the kind, so both write
		// one row.
		const onA = await Planner.upsertUpstreamLink(a.base, {
			taskId: task.id,
			provider: "linear",
			externalId: "linear-shared",
			identifier: "ENG-7",
			url: "https://linear.app/acme/issue/ENG-7/from-a",
			title: "Titled on A",
		});
		if (!onA.ok) throw onA.error;
		const onB = await Planner.upsertUpstreamLink(b.base, {
			taskId: task.id,
			provider: "linear",
			externalId: "linear-shared",
			identifier: "ENG-7",
			url: "https://linear.app/acme/issue/ENG-7/from-b",
			title: "Titled on B",
		});
		if (!onB.ok) throw onB.error;

		await converge(a, b);
		await converge(a, b);

		const rowsA = await rowsOf(a.base, TABLES.refs);
		const rowsB = await rowsOf(b.base, TABLES.refs);
		expect(rowsA).toHaveLength(1);
		expect(rowsB).toEqual(rowsA);
		expect(onA.value.id).toBe(onB.value.id);
	});
});
