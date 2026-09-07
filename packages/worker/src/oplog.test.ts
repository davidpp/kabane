import { env, runInDurableObject } from "cloudflare:test";
import type { Result } from "@cabane/core";
import { describe, expect, it } from "vitest";
import type { CabaneLog } from "./log";
import type { PullPage, PushAck, WireOp } from "./wire";

const DEVICE_A = "device-a";
const DEVICE_B = "device-b";

const log = (name: string) => env.CABANE_LOG.getByName(name);

const op = (opId: string, deviceId: string, extra: object = {}): WireOp => ({
	opId,
	deviceId,
	tbl: "tasks",
	rowId: `row-${opId}`,
	op: "insert",
	capturedAt: "2026-08-03T12:00:00.000Z",
	...extra,
});

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
	return result.value;
};

const push = async (
	name: string,
	deviceId: string,
	ops: WireOp[],
): Promise<PushAck> => unwrap(await log(name).push({ deviceId, ops }));

const pull = async (
	name: string,
	deviceId: string,
	sinceSeq: number,
	limit: number,
): Promise<PullPage> =>
	unwrap(await log(name).pull({ deviceId, sinceSeq, limit }));

const payloads = (page: PullPage): WireOp[] =>
	page.ops.map((o) => JSON.parse(o.payload) as WireOp);

describe("push", () => {
	it("appends a batch and reports the head", async () => {
		const ack = await push("append", DEVICE_A, [
			op("op-1", DEVICE_A),
			op("op-2", DEVICE_A),
		]);

		expect(ack).toEqual({ accepted: 2, duplicates: 0, head: 2 });
	});

	it("accepts an empty batch without moving the head", async () => {
		await push("empty", DEVICE_A, [op("op-1", DEVICE_A)]);

		expect(await push("empty", DEVICE_A, [])).toEqual({
			accepted: 0,
			duplicates: 0,
			head: 1,
		});
	});

	it("is idempotent on opId and never re-issues a server_seq", async () => {
		const first = await push("replay", DEVICE_A, [
			op("op-1", DEVICE_A),
			op("op-2", DEVICE_A),
		]);
		expect(first).toEqual({ accepted: 2, duplicates: 0, head: 2 });

		const seqsAfterFirst = await storedSeqs("replay");

		// The lost-ack case: the client never saw the ack and pushes the same ops.
		const replay = await push("replay", DEVICE_A, [
			op("op-1", DEVICE_A),
			op("op-2", DEVICE_A),
		]);
		expect(replay).toEqual({ accepted: 0, duplicates: 2, head: 2 });
		expect(await storedSeqs("replay")).toEqual(seqsAfterFirst);
	});

	it("counts per op in a mixed batch", async () => {
		await push("mixed", DEVICE_A, [op("op-1", DEVICE_A)]);

		const ack = await push("mixed", DEVICE_A, [
			op("op-1", DEVICE_A),
			op("op-2", DEVICE_A),
		]);

		expect(ack.accepted).toBe(1);
		expect(ack.duplicates).toBe(1);
	});

	it("treats a repeat inside one batch as a duplicate", async () => {
		const ack = await push("intra-batch", DEVICE_A, [
			op("op-1", DEVICE_A),
			op("op-1", DEVICE_A),
		]);

		expect(ack).toEqual({ accepted: 1, duplicates: 1, head: 1 });
	});

	it("stores the payload verbatim, including fields it knows nothing about", async () => {
		// The opacity guarantee: this Worker holds no planner schema, so a device
		// running a newer `db-registration.ts` must round-trip unchanged.
		const exotic = op("op-1", DEVICE_A, {
			payload: { title: "hi", nested: { deep: [1, 2, 3] }, ratio: 1.5 },
			columnFromTheFuture: null,
		});
		await push("opaque", DEVICE_A, [exotic]);

		const page = await pull("opaque", DEVICE_B, 0, 10);

		expect(payloads(page)[0]).toEqual(exotic);
	});

	it("registers the pushing device", async () => {
		await log("devices").push({
			deviceId: DEVICE_A,
			name: "laptop",
			ops: [op("op-1", DEVICE_A)],
		});

		expect(await devices("devices")).toEqual([
			{ device_id: DEVICE_A, name: "laptop", last_ack_seq: 0 },
		]);
	});

	it("carries a batch far past the 100-bound-parameter cap", async () => {
		// 50 ops is 200 parameters row-per-statement, which is why the batch goes
		// in as one JSON parameter unpacked with json_each.
		const ops = Array.from({ length: 50 }, (_, i) =>
			op(`op-${i}`, DEVICE_A, { payload: { title: `task ${i}` } }),
		);

		const ack = await push("big-batch", DEVICE_A, ops);

		expect(ack).toEqual({ accepted: 50, duplicates: 0, head: 50 });
		const page = await pull("big-batch", DEVICE_B, 0, 100);
		expect(page.ops.length).toBe(50);
		expect(payloads(page).at(-1)).toEqual(ops.at(-1));
	});

	it("fails closed on an op too big to store, and stays usable", async () => {
		// 2 MB is the row/string limit. The batch must roll back and the object must
		// survive — a sync failure can never be allowed to take the log with it.
		const oversized = await log("toobig").push({
			deviceId: DEVICE_A,
			ops: [op("op-1", DEVICE_A, { payload: { blob: "x".repeat(2_500_000) } })],
		});

		expect(oversized.ok).toBe(false);
		if (!oversized.ok) expect(oversized.error).toBeInstanceOf(Error);

		expect(await push("toobig", DEVICE_A, [op("op-2", DEVICE_A)])).toEqual({
			accepted: 1,
			duplicates: 0,
			head: 1,
		});
	});
});

describe("pull", () => {
	it("returns other devices' ops in server_seq order", async () => {
		await push("ordering", DEVICE_B, [
			op("op-1", DEVICE_B),
			op("op-2", DEVICE_B),
			op("op-3", DEVICE_B),
		]);

		const page = await pull("ordering", DEVICE_A, 0, 10);

		expect(page.ops.map((o) => o.serverSeq)).toEqual([1, 2, 3]);
		expect(payloads(page).map((o) => o.opId)).toEqual(["op-1", "op-2", "op-3"]);
		expect(page).toMatchObject({ throughSeq: 3, hasMore: false });
	});

	it("withholds the caller's own ops", async () => {
		await push("withhold", DEVICE_A, [op("a-1", DEVICE_A)]);
		await push("withhold", DEVICE_B, [op("b-1", DEVICE_B)]);

		const forA = await pull("withhold", DEVICE_A, 0, 10);
		const forB = await pull("withhold", DEVICE_B, 0, 10);

		expect(payloads(forA).map((o) => o.opId)).toEqual(["b-1"]);
		expect(payloads(forB).map((o) => o.opId)).toEqual(["a-1"]);
	});

	it("pages with hasMore and resumes from throughSeq", async () => {
		await push(
			"paging",
			DEVICE_B,
			Array.from({ length: 5 }, (_, i) => op(`op-${i}`, DEVICE_B)),
		);

		const first = await pull("paging", DEVICE_A, 0, 2);
		expect(first).toMatchObject({ throughSeq: 2, hasMore: true });
		expect(payloads(first).map((o) => o.opId)).toEqual(["op-0", "op-1"]);

		const second = await pull("paging", DEVICE_A, first.throughSeq, 2);
		expect(second).toMatchObject({ throughSeq: 4, hasMore: true });
		expect(payloads(second).map((o) => o.opId)).toEqual(["op-2", "op-3"]);

		const third = await pull("paging", DEVICE_A, second.throughSeq, 2);
		expect(third).toMatchObject({ throughSeq: 5, hasMore: false });
		expect(payloads(third).map((o) => o.opId)).toEqual(["op-4"]);
	});

	it("advances throughSeq on a page whose every op was withheld", async () => {
		// THE STALL BUG. A's own three ops fill the window, so the page yields
		// nothing — and still has to move the watermark. Deriving the cursor from
		// the last returned op would leave sinceSeq at 0 with hasMore true, and the
		// client would re-read this same page forever.
		await push("stall", DEVICE_A, [
			op("a-1", DEVICE_A),
			op("a-2", DEVICE_A),
			op("a-3", DEVICE_A),
		]);
		await push("stall", DEVICE_B, [op("b-1", DEVICE_B)]);

		const blind = await pull("stall", DEVICE_A, 0, 3);

		expect(blind.ops).toEqual([]);
		expect(blind.throughSeq).toBe(3);
		expect(blind.hasMore).toBe(true);

		const next = await pull("stall", DEVICE_A, blind.throughSeq, 3);
		expect(payloads(next).map((o) => o.opId)).toEqual(["b-1"]);
		expect(next).toMatchObject({ throughSeq: 4, hasMore: false });
	});

	it("holds throughSeq at sinceSeq when the log has nothing new", async () => {
		await push("caught-up", DEVICE_B, [op("op-1", DEVICE_B)]);

		const page = await pull("caught-up", DEVICE_A, 1, 10);

		expect(page).toEqual({ ops: [], throughSeq: 1, hasMore: false });
	});

	it("records how far a device has been handed", async () => {
		await push("ack", DEVICE_B, [op("op-1", DEVICE_B), op("op-2", DEVICE_B)]);

		await pull("ack", DEVICE_A, 0, 1);
		expect(await ackSeq("ack", DEVICE_A)).toBe(1);

		await pull("ack", DEVICE_A, 1, 10);
		expect(await ackSeq("ack", DEVICE_A)).toBe(2);

		// Advisory and monotonic: a client re-reading an old page must not rewind it.
		await pull("ack", DEVICE_A, 0, 1);
		expect(await ackSeq("ack", DEVICE_A)).toBe(2);
	});
});

// ============================================================
// Storage assertions
// ============================================================

type DeviceRow = {
	device_id: string;
	name: string | null;
	last_ack_seq: number;
};

const storedSeqs = async (name: string): Promise<Record<string, number>> => {
	const rows = await runInDurableObject(
		log(name),
		(_instance: CabaneLog, ctx) =>
			ctx.storage.sql
				.exec<{ op_id: string; server_seq: number }>(
					"SELECT op_id, server_seq FROM oplog ORDER BY server_seq",
				)
				.toArray(),
	);
	return Object.fromEntries(rows.map((r) => [r.op_id, r.server_seq]));
};

const devices = async (name: string): Promise<DeviceRow[]> =>
	runInDurableObject(log(name), (_instance: CabaneLog, ctx) =>
		ctx.storage.sql
			.exec<DeviceRow>("SELECT * FROM devices ORDER BY device_id")
			.toArray(),
	);

const ackSeq = async (name: string, deviceId: string): Promise<number> => {
	const rows = await devices(name);
	return rows.find((r) => r.device_id === deviceId)?.last_ack_seq ?? -1;
};
