/**
 * Edges of applying a pulled op to the 2.0 record (JCAB-658 review): what
 * apply refuses before it compares or stores, and what record ops must never
 * touch.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb as runWithDb } from "../runtime";
import { isRecordTable, RecordKey, type SyncOp } from "../schemas";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { RecordRead } from "../storage/record";
import { Apply } from "./apply";

type Row = Record<string, unknown>;

const T0 = "2026-01-01T00:00:00.000Z";
let bases: string[] = [];

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const withDb = async <T>(base: string, fn: (db: Db) => T): Promise<T> =>
	unwrap(await runWithDb(base, fn));

const device = async (): Promise<string> => {
	const base = join(tmpdir(), `record-apply-${crypto.randomUUID()}`);
	mkdirSync(base, { recursive: true });
	bases.push(base);
	unwrap(await Planner.init(base));
	await withDb(base, (db) => unwrap(Oplog.initDevice(db, "reader")));
	return base;
};

const thread = (id: string, fields: Row = {}): Row => ({
	id,
	short_id: null,
	kind: "issue",
	kind_version: null,
	title: id,
	body: null,
	scope: null,
	parent_id: null,
	created_by: null,
	created_at: T0,
	visibility: "shared",
	updated_at: T0,
	updated_by: null,
	updated_device: "",
	version: 1,
	state: null,
	assignee: null,
	state_updated_at: T0,
	state_updated_by: null,
	state_updated_device: "",
	state_version: 1,
	deleted_at: null,
	deleted_device: null,
	...fields,
});

const entry = (id: string, fields: Row = {}): Row => ({
	id,
	thread_id: "thread",
	kind: "claim",
	kind_version: null,
	author: "kabane://actor/agent/claude",
	body: null,
	addressed_to: null,
	re: null,
	data: null,
	visibility: "shared",
	created_at: T0,
	updated_by: null,
	created_device: "d",
	version: 1,
	...fields,
});

let opCount = 0;
const op = (
	tbl: string,
	payload: Row,
	extra: Partial<SyncOp> = {},
): SyncOp => ({
	opId: `op-${++opCount}`,
	deviceId: `writer-${opCount}`,
	tbl,
	rowId:
		(isRecordTable(tbl) ? RecordKey.rowIdOf(tbl, payload) : undefined) ??
		String(payload.id),
	op: "insert",
	payload,
	capturedAt: T0,
	...extra,
});

const apply = async (base: string, ops: readonly SyncOp[]) =>
	unwrap(
		await Apply.applyBatch(base, {
			ops: ops.map((o, i) => ({ ...o, serverSeq: i + 1 })),
			throughSeq: ops.length,
			hasMore: false,
		}),
	);

/** Apply `ops` in the order given and reversed, each on a fresh device. */
const bothOrders = async <T>(
	ops: readonly SyncOp[],
	read: (db: Db) => T,
): Promise<T[]> => {
	const out: T[] = [];
	for (const order of [ops, [...ops].reverse()]) {
		const base = await device();
		await apply(base, order);
		out.push(await withDb(base, read));
	}
	return out;
};

describe("2.0 record — what apply refuses", () => {
	beforeEach(() => {
		bases = [];
	});

	afterEach(() => {
		for (const base of bases) rmSync(base, { recursive: true, force: true });
	});

	it("skips a row holding ill-formed Unicode, which SQLite would store as something else", async () => {
		const ops = [
			op("threads", thread("thread", { title: "\ud800" })),
			op("threads", thread("thread", { title: "z" })),
		];
		const stored = await bothOrders(ops, (db) =>
			db.query<{ h: string }, []>("SELECT hex(title) AS h FROM threads").all(),
		);
		expect(stored).toEqual([[{ h: "7A" }], [{ h: "7A" }]]);

		const base = await device();
		const report = await apply(base, [
			op("threads", thread("\udfff-thread")),
			ops[0] ?? op("threads", thread("unused")),
		]);
		expect(report.skipped["malformed-payload"]).toBe(2);
	});

	it("skips a row whose clock is not a UTC instant in the one sortable form", async () => {
		const ops = [
			op("threads", thread("thread")),
			op(
				"entries",
				entry("earlier", { created_at: "2026-01-01T01:00:00+02:00" }),
			),
			op("entries", entry("later", { author: "kabane://actor/agent/codex" })),
			op("threads", thread("no-ms", { updated_at: "2026-01-01T00:00:00Z" })),
		];
		const held = await bothOrders(ops, (db) => [
			unwrap(RecordRead.claimHolder(db, "thread"))?.id,
			db
				.query<{ n: number }, []>(
					"SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM threads) AS n",
				)
				.get()?.n,
		]);
		expect(held).toEqual([
			["later", 2],
			["later", 2],
		]);
	});

	it("skips an op whose row id does not name its row's key, in the one form", async () => {
		const stamps = {
			removed_at: null,
			visibility: "shared",
			updated_at: T0,
			updated_by: null,
			updated_device: "d",
			version: 1,
		};
		const attribute = { ...stamps, thread_id: "thread", key: "priority" };
		const ref = {
			...stamps,
			thread_id: "thread",
			uri: "file:spec.md",
			kind: "spec",
			kind_version: null,
			title: null,
			data: null,
		};
		const base = await device();
		const report = await apply(base, [
			op("threads", thread("thread")),
			op("attributes", { ...attribute, value: "high" }),
			// The envelope names another key than the row's.
			op(
				"attributes",
				{ ...attribute, value: "low" },
				{ rowId: JSON.stringify(["thread", "agent"]) },
			),
			// The right parts, not in JSON.stringify's form.
			op("refs", ref, { rowId: '["thread", "file:spec.md", "spec"]' }),
			// No JSON array at all.
			op("refs", ref, { rowId: "thread file:spec.md spec" }),
		]);
		expect(report.skipped["malformed-payload"]).toBe(3);
		expect(
			await withDb(base, (db) => [
				db.query<Row, []>("SELECT thread_id, key, value FROM attributes").all(),
				db.query<Row, []>("SELECT COUNT(*) AS n FROM refs").get(),
			]),
		).toEqual([
			[{ thread_id: "thread", key: "priority", value: "high" }],
			{ n: 0 },
		]);
	});

	it("parks a module-tagged op on a record table's name, never applies it as a record row", async () => {
		const base = await device();
		const report = await apply(base, [
			op("threads", thread("thread"), {
				module: { name: "example", schema: 1 },
			}),
		]);
		expect(report).toMatchObject({ applied: 0, parked: 1 });
		expect(
			await withDb(base, (db) =>
				db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM threads").get(),
			),
		).toEqual({ n: 0 });
	});

	it("raises no counter for a thread op it refused, nor for a label it does not mint", async () => {
		const base = await device();
		const report = await apply(base, [
			op("threads", { id: "01KZREFUSED000000000000000", short_id: "JTES-99" }),
			op(
				"threads",
				thread("01KZODDLABEL00000000000000", { short_id: "ODD-7" }),
			),
		]);
		expect(report.skipped["malformed-payload"]).toBe(1);
		expect(
			await withDb(base, (db) =>
				db.query<{ prefix: string }, []>("SELECT prefix FROM sequences").all(),
			),
		).toEqual([]);
		const added = unwrap(
			await Planner.addTask(base, { title: "next", scopeUri: "tes" }),
		);
		expect(added.shortId).toBe("JTES-1");
	});
});
