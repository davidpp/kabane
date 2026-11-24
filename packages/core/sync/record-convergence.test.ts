/**
 * The 2.0 record converges in every delivery order (JCAB-658).
 *
 * Devices write the five tables the way a storage writer will: read the row,
 * change one group, stamp that group's clock (never below the stored one), its
 * counter and the writing device, then capture it. Their ops go through the
 * in-process relay, and the same ops are then read back as one file per
 * device, in every interleaving that keeps each file's own order, as one pass
 * and one op per pass. Every reading must leave the same stored rows and the
 * same visible rows, and delivering every op a second time must change
 * nothing.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb as runWithDb } from "../runtime";
import { RECORD_TABLES, RecordId } from "../schemas";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { RecordRead, VISIBLE_THREADS_SQL } from "../storage/record";
import { Apply } from "./apply";
import { LocalRelay, type Relay } from "./local-relay";
import { Sync } from "./namespace";
import type { RelayOp, SyncTransport } from "./transport";

type Row = Record<string, unknown>;

type Device = { base: string; deviceId: string; transport: SyncTransport };

const ACTOR = "kabane://actor/agent/claude";

let relay: Relay;
let bases: string[];

// ============================================================
// Devices
// ============================================================

const withDb = async <T>(base: string, fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const createDevice = async (deviceId: string): Promise<Device> => {
	const base = join(tmpdir(), `record-sync-${deviceId}-${crypto.randomUUID()}`);
	mkdirSync(base, { recursive: true });
	bases.push(base);
	unwrap(await Planner.init(base));
	await withDb(base, (db) => unwrap(Oplog.initDevice(db, deviceId)));
	return {
		base,
		deviceId,
		transport: LocalRelay.transportFor(relay, deviceId),
	};
};

const devices = (...ids: string[]) => Promise.all(ids.map(createDevice));

const push = async (device: Device) =>
	unwrap(await Sync.push(device.base, device.transport));

const pull = async (device: Device) =>
	unwrap(await Sync.pull(device.base, device.transport));

/** Push, then pull, every device, a few rounds over. */
const settle = async (all: readonly Device[]) => {
	for (let round = 0; round < 3; round++) {
		for (const d of all) await push(d);
		for (const d of all) await pull(d);
	}
};

// ============================================================
// The writer
// ============================================================

/** Second `n` of the test's day: clocks the cases choose, so ties are exact. */
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** A group's clock never goes back below the one stored. */
const notBelow = (clock: string, stored: unknown): string =>
	typeof stored === "string" && stored > clock ? stored : clock;

const nextCount = (stored: unknown): number =>
	(typeof stored === "number" ? stored : 0) + 1;

const upsert = (db: Db, table: string, row: Row) => {
	const columns = Object.keys(row);
	db.run(
		`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")})
		 VALUES (${columns.map(() => "?").join(", ")})
		 ON CONFLICT(id) DO UPDATE SET ${columns
				.filter((c) => c !== "id")
				.map((c) => `"${c}" = excluded."${c}"`)
				.join(", ")}`,
		columns.map((c) => {
			const value = row[c];
			return typeof value === "string" || typeof value === "number"
				? value
				: null;
		}),
	);
};

/** Read the row, let `next` change it (undefined: write nothing), write and capture. */
const write = (
	device: Device,
	table: string,
	id: string,
	next: (stored: Row | undefined) => Row | undefined,
) =>
	withDb(device.base, (db) => {
		const stored =
			db.query<Row, [string]>(`SELECT * FROM ${table} WHERE id = ?`).get(id) ??
			undefined;
		const row = next(stored);
		if (row === undefined) return;
		upsert(db, table, { ...row, id });
		Oplog.afterWrite(db, table, stored === undefined ? "insert" : "update", id);
	});

type ThreadFields = Partial<{
	title: string;
	kind: string;
	scope: string | null;
	parent_id: string | null;
}>;

/** Create a thread, or change its text group. A deleted thread takes no write. */
const thread = (d: Device, id: string, clock: string, fields: ThreadFields) =>
	write(d, "threads", id, (stored) => {
		if (stored !== undefined && stored.deleted_at !== null) return undefined;
		const base = stored ?? {
			short_id: null,
			kind: "issue",
			kind_version: null,
			title: "",
			body: null,
			scope: null,
			parent_id: null,
			created_by: ACTOR,
			created_at: clock,
			visibility: "shared",
			state: null,
			assignee: null,
			state_updated_at: clock,
			state_updated_by: ACTOR,
			state_updated_device: d.deviceId,
			state_version: 1,
			deleted_at: null,
			deleted_device: null,
		};
		return {
			...base,
			...fields,
			updated_at: notBelow(clock, stored?.updated_at),
			updated_by: ACTOR,
			updated_device: d.deviceId,
			version: nextCount(stored?.version),
		};
	});

/** Change the claim group: state and assignee. */
const claim = (
	d: Device,
	id: string,
	clock: string,
	state: string | null,
	assignee: string | null,
) =>
	write(d, "threads", id, (stored) =>
		stored === undefined || stored.deleted_at !== null
			? undefined
			: {
					...stored,
					state,
					assignee,
					state_updated_at: notBelow(clock, stored.state_updated_at),
					state_updated_by: ACTOR,
					state_updated_device: d.deviceId,
					state_version: nextCount(stored.state_version),
				},
	);

const deleteThread = (d: Device, id: string, clock: string) =>
	write(d, "threads", id, (stored) =>
		stored === undefined || stored.deleted_at !== null
			? undefined
			: { ...stored, deleted_at: clock, deleted_device: d.deviceId },
	);

const entry = (
	d: Device,
	id: string,
	threadId: string,
	kind: string,
	clock: string,
	author = ACTOR,
) =>
	write(d, "entries", id, (stored) =>
		stored !== undefined
			? undefined
			: {
					thread_id: threadId,
					kind,
					kind_version: null,
					author,
					body: `${kind} ${id}`,
					addressed_to: null,
					re: null,
					data: null,
					visibility: "shared",
					created_at: clock,
					updated_by: ACTOR,
					created_device: d.deviceId,
					version: 1,
				},
	);

/** Set (or, with `removed`, remove) an attribute, link or ref: one register per row. */
const keyed = (
	d: Device,
	table: "attributes" | "links" | "refs",
	id: string,
	clock: string,
	fields: Row,
	removed = false,
) =>
	write(d, table, id, (stored) => {
		if (removed && (stored === undefined || stored.removed_at !== null))
			return undefined;
		const stamped = notBelow(clock, stored?.updated_at);
		return {
			visibility: "shared",
			...stored,
			...fields,
			removed_at: removed ? stamped : null,
			updated_at: stamped,
			updated_by: ACTOR,
			updated_device: d.deviceId,
			version: nextCount(stored?.version),
		};
	});

const attribute = async (
	d: Device,
	threadId: string,
	key: string,
	value: string | null,
	clock: string,
	removed = false,
) =>
	keyed(
		d,
		"attributes",
		unwrap(await RecordId.attribute(threadId, key)),
		clock,
		{ thread_id: threadId, key, key_version: null, value },
		removed,
	);

const link = async (
	d: Device,
	source: string,
	target: string,
	type: string,
	clock: string,
	removed = false,
) =>
	keyed(
		d,
		"links",
		unwrap(await RecordId.link(source, target, type)),
		clock,
		{ source_id: source, target_id: target, type },
		removed,
	);

const ref = async (
	d: Device,
	threadId: string,
	uri: string,
	clock: string,
	removed = false,
) =>
	keyed(
		d,
		"refs",
		unwrap(await RecordId.ref(threadId, uri)),
		clock,
		{
			thread_id: threadId,
			uri,
			kind: "spec",
			kind_version: null,
			title: null,
			data: null,
		},
		removed,
	);

const upstream = async (
	d: Device,
	threadId: string,
	externalId: string,
	url: string,
	clock: string,
) =>
	keyed(
		d,
		"refs",
		unwrap(await RecordId.upstreamRef(threadId, "github", externalId)),
		clock,
		{
			thread_id: threadId,
			uri: url,
			kind: "upstream",
			kind_version: null,
			title: null,
			data: JSON.stringify({ provider: "github", externalId }),
		},
	);

// ============================================================
// What a device holds
// ============================================================

type Snapshot = {
	stored: Record<string, Row[]>;
	visible: Record<string, unknown[]>;
};

const snapshot = (base: string): Promise<Snapshot> =>
	withDb(base, (db) => ({
		stored: Object.fromEntries(
			RECORD_TABLES.map((table) => [
				table,
				db.query<Row, []>(`SELECT * FROM ${table} ORDER BY id`).all(),
			]),
		),
		visible: {
			threads: unwrap(RecordRead.threads(db)),
			entries: unwrap(RecordRead.entries(db)),
			attributes: unwrap(RecordRead.attributes(db)),
			links: unwrap(RecordRead.links(db)),
			refs: unwrap(RecordRead.refs(db)),
		},
	}));

const expectSame = async (all: readonly Device[]): Promise<Snapshot> => {
	const [first, ...rest] = all;
	if (first === undefined) throw new Error("no device");
	const expected = await snapshot(first.base);
	for (const d of rest)
		expect(
			await snapshot(d.base),
			`${d.deviceId} vs ${first.deviceId}`,
		).toEqual(expected);
	return expected;
};

// ============================================================
// Readings of per-device files
// ============================================================

/** The ops each device pushed, in its own order: its file. */
const fileOf = (device: Device): RelayOp[] =>
	LocalRelay.ops(relay).filter((op) => op.deviceId === device.deviceId);

const filesOf = (log: readonly RelayOp[]): RelayOp[][] => {
	const files = new Map<string, RelayOp[]>();
	for (const op of log) {
		const file = files.get(op.deviceId) ?? [];
		file.push(op);
		files.set(op.deviceId, file);
	}
	return [...files.values()];
};

/** Seeded, so a failing workload can be named and replayed. */
const mulberry32 = (seed: number) => () => {
	let t = (seed += 0x6d2b79f5);
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Apply ops in reading order, `serverSeq` renumbered, in passes of `pass()` ops. */
const applyRead = async (
	observer: Device,
	ops: readonly RelayOp[],
	pass: () => number,
) => {
	const read = ops.map((op, i) => ({ ...op, serverSeq: i + 1 }));
	for (let start = 0; start < read.length;) {
		const batch = read.slice(start, start + pass());
		start += batch.length;
		unwrap(
			await Apply.applyBatch(observer.base, {
				ops: batch,
				throughSeq: start,
				hasMore: start < read.length,
			}),
		);
	}
};

/** Every reading of `files` that keeps each file's own order. */
const interleavings = (files: readonly RelayOp[][]): RelayOp[][] => {
	const out: RelayOp[][] = [];
	const walk = (cursors: readonly number[], read: readonly RelayOp[]) => {
		let done = true;
		for (const [i, file] of files.entries()) {
			const op = file[cursors[i] ?? 0];
			if (op === undefined) continue;
			done = false;
			walk(
				cursors.map((c, j) => (j === i ? c + 1 : c)),
				[...read, op],
			);
		}
		if (done) out.push([...read]);
	};
	walk(
		files.map(() => 0),
		[],
	);
	return out;
};

/** Once more, every op, last file first and each file backwards, in one pass. */
const redeliver = (observer: Device, read: readonly RelayOp[]) =>
	applyRead(observer, [...read].reverse(), () => read.length);

let readers = 0;

/**
 * Apply `files` on fresh devices in every reading, as one pass and as one op
 * per pass, then deliver every op again; every reading must hold the same
 * stored and visible rows. Returns them, and how many readings ran.
 */
const everyReadingAgrees = async (
	files: readonly RelayOp[][],
): Promise<{ rows: Snapshot; readings: number }> => {
	const name = (read: readonly RelayOp[]) =>
		read.map((op) => `${op.deviceId} ${op.tbl} ${op.rowId}`).join(", ");
	let first: { name: string; rows: Snapshot } | undefined;
	let readings = 0;
	for (const read of interleavings(files))
		for (const [mode, pass] of [
			["one pass", () => read.length],
			["one op per pass", () => 1],
		] as const) {
			const observer = await createDevice(`reader-${readers++}`);
			await applyRead(observer, read, pass);
			const rows = await snapshot(observer.base);
			await redeliver(observer, read);
			const label = `${name(read)} (${mode})`;
			expect(
				await snapshot(observer.base),
				`${label}, delivered twice`,
			).toEqual(rows);
			readings++;
			if (first === undefined) first = { name: label, rows };
			else expect(rows, `${label}\n  vs ${first.name}`).toEqual(first.rows);
		}
	if (first === undefined) throw new Error("no reading");
	return { rows: first.rows, readings };
};

/** The racing devices' files, every reading of them, and the authors after they settle. */
const resolveRace = async (all: readonly Device[]) => {
	for (const d of all) await push(d);
	const { rows, readings } = await everyReadingAgrees(all.map(fileOf));
	await settle(all);
	expect(await expectSame(all)).toEqual(rows);
	console.log(`readings: ${readings}`);
	return rows;
};

const ids = (rows: unknown[]) => rows.map((row) => (row as Row).id as string);

const SLOW = 120_000;

// ============================================================
// Cases
// ============================================================

describe("2.0 record — convergence in every delivery order", () => {
	beforeEach(() => {
		relay = LocalRelay.create();
		bases = [];
	});

	afterEach(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});

	it(
		"makes one link of two creations, keeps an unlink, and takes a relink",
		async () => {
			const [a, b, c] = await devices("device-a", "device-b", "device-c");
			if (a === undefined || b === undefined || c === undefined) return;
			await thread(a, "thread-x", at(0), { title: "x" });
			await thread(a, "thread-y", at(0), { title: "y" });
			await push(a);
			await pull(b);
			await pull(c);

			await link(a, "thread-x", "thread-y", "blocks", at(1));
			await link(b, "thread-x", "thread-y", "blocks", at(2));
			await push(a);
			await pull(c);
			await link(c, "thread-x", "thread-y", "blocks", at(3), true);
			await push(c);
			await pull(b);
			expect((await snapshot(b.base)).visible.links).toEqual([]);
			await link(b, "thread-x", "thread-y", "blocks", at(4));

			const rows = await resolveRace([a, b, c]);
			expect(rows.stored.links).toHaveLength(1);
			expect(rows.stored.links?.[0]).toMatchObject({
				removed_at: null,
				updated_at: at(4),
			});
			expect(rows.visible.links).toHaveLength(1);
		},
		SLOW,
	);

	for (const removalLast of [false, true])
		it(
			`resolves an attribute set on one device and removed on another (${removalLast ? "removal" : "set"} last)`,
			async () => {
				const [a, b] = await devices("device-a", "device-b");
				if (a === undefined || b === undefined) return;
				await thread(a, "thread-t", at(0), { title: "t" });
				await attribute(a, "thread-t", "priority", "high", at(1));
				await push(a);
				await pull(b);

				await attribute(
					a,
					"thread-t",
					"priority",
					"low",
					at(removalLast ? 2 : 3),
				);
				await attribute(
					b,
					"thread-t",
					"priority",
					null,
					at(removalLast ? 3 : 2),
					true,
				);

				const rows = await resolveRace([a, b]);
				expect(rows.stored.attributes).toHaveLength(1);
				if (removalLast) {
					expect(rows.stored.attributes?.[0]?.removed_at).toBe(at(3));
					expect(rows.visible.attributes).toEqual([]);
				} else
					expect(rows.visible.attributes).toMatchObject([
						{ key: "priority", value: "low", removed_at: null },
					]);
			},
			SLOW,
		);

	it(
		"makes one upstream ref of the same provider id linked with two URLs",
		async () => {
			const [a, b] = await devices("device-a", "device-b");
			if (a === undefined || b === undefined) return;
			await thread(a, "thread-t", at(0), { title: "t" });
			await push(a);
			await pull(b);

			await upstream(
				a,
				"thread-t",
				"acme-7",
				"https://github.com/acme/repo/issues/7",
				at(1),
			);
			await upstream(
				b,
				"thread-t",
				"acme-7",
				"https://github.com/acme/renamed/issues/7",
				at(2),
			);

			const rows = await resolveRace([a, b]);
			expect(rows.stored.refs).toHaveLength(1);
			expect(rows.visible.refs).toMatchObject([
				{ uri: "https://github.com/acme/renamed/issues/7", kind: "upstream" },
			]);
		},
		SLOW,
	);

	for (const movedOut of [false, true])
		it(
			`hides a child moved under a parent deleted elsewhere${movedOut ? ", until a later move takes it out" : ""}`,
			async () => {
				const [a, b, d] = await devices("device-a", "device-b", "device-d");
				if (a === undefined || b === undefined || d === undefined) return;
				await thread(a, "thread-parent", at(0), { title: "parent" });
				await thread(a, "thread-child", at(0), { title: "child" });
				await thread(a, "thread-anchor", at(0), { title: "anchor" });
				await entry(a, "entry-on-child", "thread-child", "comment", at(0));
				await push(a);
				await pull(b);
				await pull(d);

				await thread(b, "thread-child", at(1), { parent_id: "thread-parent" });
				if (movedOut)
					await thread(b, "thread-child", at(3), { parent_id: null });
				await deleteThread(d, "thread-parent", at(2));

				const rows = await resolveRace([a, b, d]);
				expect(ids(rows.stored.threads ?? [])).toEqual([
					"thread-anchor",
					"thread-child",
					"thread-parent",
				]);
				if (movedOut) {
					expect(rows.visible.threads).toMatchObject([
						{ id: "thread-anchor" },
						{ id: "thread-child", parent_id: null },
					]);
					expect(ids(rows.visible.entries ?? [])).toEqual(["entry-on-child"]);
				} else {
					expect(ids(rows.visible.threads ?? [])).toEqual(["thread-anchor"]);
					expect(rows.visible.entries).toEqual([]);
				}
			},
			SLOW,
		);

	it(
		"breaks a parent cycle at its lowest id, and every thread still shows",
		async () => {
			const [a, b] = await devices("device-a", "device-b");
			if (a === undefined || b === undefined) return;
			await thread(a, "thread-x", at(0), { title: "x" });
			await thread(a, "thread-y", at(0), { title: "y" });
			await thread(a, "thread-z", at(0), { title: "z", parent_id: "thread-y" });
			await push(a);
			await pull(b);

			await thread(a, "thread-x", at(1), { parent_id: "thread-y" });
			await thread(b, "thread-y", at(1), { parent_id: "thread-x" });

			const rows = await resolveRace([a, b]);
			expect(rows.stored.threads).toMatchObject([
				{ id: "thread-x", parent_id: "thread-y" },
				{ id: "thread-y", parent_id: "thread-x" },
				{ id: "thread-z", parent_id: "thread-y" },
			]);
			expect(rows.visible.threads).toMatchObject([
				{ id: "thread-x", parent_id: null },
				{ id: "thread-y", parent_id: "thread-x" },
				{ id: "thread-z", parent_id: "thread-y" },
			]);
		},
		SLOW,
	);

	it(
		"keeps a claim that an offline title edit raced",
		async () => {
			const [a, b] = await devices("device-a", "device-b");
			if (a === undefined || b === undefined) return;
			await thread(a, "thread-t", at(0), { title: "before" });
			await push(a);
			await pull(b);

			await claim(a, "thread-t", at(2), "in_progress", "claude");
			// B's row still holds the claim group it saw before A's claim.
			await thread(b, "thread-t", at(3), { title: "edited offline" });

			const rows = await resolveRace([a, b]);
			expect(rows.visible.threads).toMatchObject([
				{ title: "edited offline", state: "in_progress", assignee: "claude" },
			]);
		},
		SLOW,
	);

	it(
		"settles an exact tie the same way on three devices, whoever receives it",
		async () => {
			const [a, b, c] = await devices("device-a", "device-b", "device-c");
			if (a === undefined || b === undefined || c === undefined) return;
			await thread(a, "thread-t", at(0), { title: "before" });
			await push(a);
			await pull(b);
			await pull(c);

			// Same clock, same counter, same actor: only the writing device differs.
			await thread(a, "thread-t", at(1), { title: "from a" });
			await thread(b, "thread-t", at(1), { title: "from b" });
			await claim(c, "thread-t", at(1), "next", "codex");

			const rows = await resolveRace([a, b, c]);
			expect(rows.visible.threads).toMatchObject([
				{ title: "from b", version: 2, state: "next" },
			]);
		},
		SLOW,
	);

	it(
		"changes nothing when a device reads the whole log again",
		async () => {
			const [a, b, c] = await devices("device-a", "device-b", "device-c");
			if (a === undefined || b === undefined || c === undefined) return;
			await thread(a, "thread-t", at(0), { title: "t" });
			await push(a);
			await pull(b);
			await thread(a, "thread-t", at(1), { title: "from a" });
			await thread(b, "thread-t", at(1), { title: "from b" });
			await attribute(b, "thread-t", "agent", "codex", at(1));
			await link(b, "thread-t", "thread-t", "related", at(1));
			await settle([a, b, c]);
			const before = await expectSame([a, b, c]);

			// A reader that lost its cursor: the same ops, every one of them, again.
			await withDb(c.base, (db) => unwrap(Oplog.resetApplied(db)));
			await pull(c);
			expect(await snapshot(c.base)).toEqual(before);
		},
		SLOW,
	);

	for (const editLast of [false, true])
		it(
			`keeps a delete final against an edit ${editLast ? "after" : "before"} it`,
			async () => {
				const [a, b] = await devices("device-a", "device-b");
				if (a === undefined || b === undefined) return;
				await thread(a, "thread-t", at(0), { title: "t" });
				await entry(a, "entry-on-t", "thread-t", "comment", at(0));
				await push(a);
				await pull(b);

				await deleteThread(b, "thread-t", at(2));
				await thread(a, "thread-t", at(editLast ? 3 : 1), { title: "edited" });

				const rows = await resolveRace([a, b]);
				expect(rows.stored.threads?.[0]?.deleted_at).toBe(at(2));
				expect(rows.visible.threads).toEqual([]);
				expect(rows.visible.entries).toEqual([]);
			},
			SLOW,
		);

	it("skips a hard delete of a record row: rows are tombstoned, never deleted", async () => {
		const [a] = await devices("device-a");
		if (a === undefined) return;
		await thread(a, "thread-t", at(0), { title: "t" });
		const before = await snapshot(a.base);
		const report = unwrap(
			await Apply.applyBatch(a.base, {
				ops: [
					{
						opId: "hard-delete",
						deviceId: "device-z",
						tbl: "threads",
						rowId: "thread-t",
						op: "delete",
						capturedAt: at(5),
						serverSeq: 1,
					},
				],
				throughSeq: 1,
				hasMore: false,
			}),
		);
		expect(report.applied).toBe(0);
		expect(await snapshot(a.base)).toEqual(before);
	});
});

// ============================================================
// Seeded workload
// ============================================================

const SEEDS = Number(process.env.RECORD_SEEDS ?? 12);

describe("2.0 record — seeded random workload over the five tables", () => {
	beforeEach(() => {
		relay = LocalRelay.create();
		bases = [];
	});

	afterEach(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});

	for (let seed = 1; seed <= SEEDS; seed++)
		it(
			`converges three devices through the hub and in any file order (seed ${seed})`,
			async () => {
				const random = mulberry32(seed);
				const below = (n: number) => Math.floor(random() * n);
				const pick = <T>(list: readonly T[]): T | undefined =>
					list[below(list.length)];
				const authors = await devices("device-a", "device-b", "device-c");
				const threadIds = (d: Device) =>
					withDb(d.base, (db) =>
						db
							.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id")
							.all()
							.map((row) => row.id),
					);

				for (let step = 0; step < 120; step++) {
					// Four steps share each clock value, so ties are common.
					const clock = at(Math.floor(step / 4));
					const d = pick(authors);
					if (d === undefined) throw new Error("no device");
					const known = await threadIds(d);
					const some = pick(known);
					const other = pick(known);
					const roll = below(16);
					if (roll <= 1 || some === undefined || other === undefined)
						await thread(d, `t-${seed}-${step}`, clock, {
							title: `created ${step}`,
							parent_id: roll === 1 ? (some ?? null) : null,
						});
					else if (roll === 2)
						await thread(d, some, clock, { title: `edited ${step}` });
					else if (roll === 3)
						await thread(d, some, clock, {
							parent_id: below(3) === 0 ? null : other,
						});
					else if (roll === 4)
						await claim(
							d,
							some,
							clock,
							pick(["next", "in_progress", "done"]) ?? null,
							pick(["claude", "codex", null]) ?? null,
						);
					else if (roll === 5) await deleteThread(d, some, clock);
					else if (roll === 6)
						await entry(
							d,
							`e-${seed}-${step}`,
							some,
							pick(["claim", "release", "comment"]) ?? "comment",
							clock,
							pick([ACTOR, "kabane://actor/agent/codex"]),
						);
					else if (roll === 7)
						await attribute(
							d,
							some,
							pick(["priority", "agent"]) ?? "agent",
							pick(["a", "b", null]) ?? null,
							clock,
						);
					else if (roll === 8)
						await link(
							d,
							some,
							other,
							pick(["blocks", "related"]) ?? "blocks",
							clock,
						);
					else if (roll === 9)
						await ref(d, some, pick(["file:a", "file:b"]) ?? "file:a", clock);
					else if (roll === 10)
						await upstream(
							d,
							some,
							pick(["1", "2"]) ?? "1",
							`https://example.test/${step}`,
							clock,
						);
					else if (roll === 11) {
						const table =
							pick(["attributes", "links", "refs"] as const) ?? "links";
						const held = await withDb(d.base, (db) =>
							db
								.query<{ id: string }, []>(
									`SELECT id FROM ${table} WHERE removed_at IS NULL ORDER BY id`,
								)
								.all()
								.map((row) => row.id),
						);
						const id = pick(held);
						if (id !== undefined) await keyed(d, table, id, clock, {}, true);
					} else {
						await push(d);
						unwrap(
							await Sync.pull(d.base, d.transport, {
								limit: 1 + below(6),
								maxBatches: 1,
							}),
						);
					}
				}
				await settle(authors);
				const expected = await expectSame(authors);
				for (const table of RECORD_TABLES)
					expect(
						expected.stored[table]?.length,
						`${table} is empty: the seed proves nothing about it`,
					).toBeGreaterThan(0);
				const count = (table: string, where: string) =>
					withDb(
						authors[0]?.base ?? "",
						(db) =>
							db
								.query<{ n: number }, []>(
									`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
								)
								.get()?.n,
					);
				console.log(
					`seed ${seed}: ops ${LocalRelay.ops(relay).length}, threads ${expected.stored.threads?.length} (deleted ${await count("threads", "deleted_at IS NOT NULL")}, on a parent cycle ${await withDb(authors[0]?.base ?? "", (db) => db.query<{ n: number }, []>(`${VISIBLE_THREADS_SQL} SELECT COUNT(DISTINCT start) AS n FROM up WHERE start = node`).get()?.n)}, visible ${expected.visible.threads?.length}), entries ${expected.stored.entries?.length}, removed attributes/links/refs ${await count("attributes", "removed_at IS NOT NULL")}/${await count("links", "removed_at IS NOT NULL")}/${await count("refs", "removed_at IS NOT NULL")}`,
				);

				const files = filesOf(LocalRelay.ops(relay));
				for (let n = 0; n < 2; n++) {
					const queues = files.map((file) => [...file]);
					const read: RelayOp[] = [];
					for (;;) {
						const open = queues.flatMap((q, i) => (q.length > 0 ? [i] : []));
						const op = queues[pick(open) ?? -1]?.shift();
						if (op === undefined) break;
						read.push(op);
					}
					const observer = await createDevice(`observer-${seed}-${n}`);
					await applyRead(observer, read, () => 1 + below(6));
					expect(await snapshot(observer.base), `reading ${n}`).toEqual(
						expected,
					);
					await redeliver(observer, read);
					expect(
						await snapshot(observer.base),
						`reading ${n}, delivered twice`,
					).toEqual(expected);
				}
			},
			SLOW,
		);
});
