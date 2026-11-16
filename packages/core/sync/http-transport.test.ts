/**
 * HTTP client decisions over a local HTTP handler backed by the shipped relay.
 * Fault responses exercise retry, quarantine and reset handling; Worker tests own the server contract.
 */
import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";
import { SyncOpSchema, type SyncOp } from "../schemas";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { HttpTransport } from "./http-transport";
import { LocalRelay } from "./local-relay";
import { Sync } from "./namespace";

const DEVICE = "device-alpha";
const OTHER = "device-beta";
const TOKEN = "test-token";

let base: string;
let relay = LocalRelay.create();
let server: ReturnType<typeof Bun.serve>;
let calls: { route: string; ops: SyncOp[]; bytes: number; limit?: number }[];
let maxBodyBytes: number;
let transientFailures: number;
let loseAck: boolean;
let pullResponse: Response | undefined;

// Only adapt the wire shape; ordering, deduplication and paging belong to LocalRelay.
const handleRequest = async (request: Request): Promise<Response> => {
	const route = new URL(request.url).pathname;
	const text = await request.text();
	const body: unknown = JSON.parse(text);
	const parsed = z
		.object({
			deviceId: z.string(),
			ops: z.array(SyncOpSchema).default([]),
			sinceSeq: z.number().default(0),
			limit: z.number().optional(),
		})
		.safeParse(body);
	if (!parsed.success)
		return new Response(parsed.error.message, { status: 400 });
	const { deviceId, ops, sinceSeq, limit } = parsed.data;
	calls.push({ route, ops, bytes: Buffer.byteLength(text), limit });
	if (request.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
		return new Response("unauthorized", { status: 401 });
	}
	const transport = LocalRelay.transportFor(relay, deviceId);
	if (route === "/push") {
		if (transientFailures > 0) {
			transientFailures--;
			return new Response("storage busy", { status: 500 });
		}
		if (Buffer.byteLength(text) > maxBodyBytes) {
			return new Response("too large", { status: 500 });
		}
		const ack = await transport.push(ops);
		if (!ack.ok) return new Response(ack.error.message, { status: 400 });
		if (loseAck) {
			loseAck = false;
			return new Response("lost ack", { status: 503 });
		}
		return Response.json(ack.value);
	}
	if (route === "/pull") {
		if (pullResponse) return pullResponse;
		const page = await transport.pull(sinceSeq, limit ?? 500);
		if (!page.ok) return new Response(page.error.message, { status: 400 });
		return Response.json({
			...page.value,
			ops: page.value.ops.map(({ serverSeq, ...op }) => ({
				serverSeq,
				payload: JSON.stringify(op),
			})),
		});
	}
	return new Response("not found", { status: 404 });
};

const seed = async (op: SyncOp) => {
	const result = await LocalRelay.transportFor(relay, OTHER).push([op]);
	if (!result.ok) throw result.error;
};

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const transportFor = (
	overrides: { maxAttempts?: number; batchBytes?: number; token?: string } = {},
) =>
	HttpTransport.create(base, {
		url: `${server.url}/`,
		token: overrides.token ?? TOKEN,
		deviceId: DEVICE,
		batchBytes: overrides.batchBytes ?? 4096,
		maxAttempts: overrides.maxAttempts ?? 2,
		sleep: async () => {},
	});

const AT = "2026-08-03T00:00:00.000Z";

let opCounter = 0;

/**
 * A capture-shaped op. The row snapshot is a full `tasks` row because the
 * pull-side tests run it through `Apply`, where a missing NOT NULL column would
 * roll the batch back rather than fail the assertion under test.
 */
const makeOp = (overrides: Partial<SyncOp> = {}): SyncOp => {
	opCounter++;
	const rowId = overrides.rowId ?? `row-${opCounter}`;
	return {
		opId: `op-${opCounter}`,
		deviceId: DEVICE,
		tbl: "tasks",
		rowId,
		op: "insert",
		rowUpdatedAt: AT,
		payload: taskRow(rowId, `task ${opCounter}`),
		capturedAt: AT,
		...overrides,
	};
};

const taskRow = (
	id: string,
	title: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	id,
	title,
	kind: "task",
	state: "inbox",
	priority: "normal",
	source: "human",
	discovered_at: AT,
	created_at: AT,
	updated_at: AT,
	...extra,
});

/** An op whose serialized size exceeds `bytes`. */
const fatOp = (bytes: number, overrides: Partial<SyncOp> = {}): SyncOp => {
	const rowId = overrides.rowId ?? `fat-${++opCounter}`;
	return makeOp({
		rowId,
		payload: taskRow(rowId, "fat", { description: "x".repeat(bytes) }),
		...overrides,
	});
};

beforeEach(async () => {
	base = join(tmpdir(), `planner-http-${crypto.randomUUID()}`);
	mkdirSync(base, { recursive: true });

	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
	await withDb((db) => {
		const armed = Oplog.initDevice(db, DEVICE);
		if (!armed.ok) throw armed.error;
	});

	relay = LocalRelay.create();
	calls = [];
	maxBodyBytes = Number.POSITIVE_INFINITY;
	transientFailures = 0;
	loseAck = false;
	pullResponse = undefined;
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handleRequest });
});

afterEach(async () => {
	await server?.stop(true);
	rmSync(base, { recursive: true, force: true });
});

// ============================================================
// Chunking
// ============================================================

describe("push chunking", () => {
	it("splits a batch that exceeds batchBytes across requests", async () => {
		const transport = transportFor({ batchBytes: 4000 });
		// Three ops of ~1.7 KB against a 4 KB ceiling: 2 + 1.
		const ops = [fatOp(1500), fatOp(1500), fatOp(1500)];

		const ack = await transport.push(ops);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		const pushes = calls.filter((c) => c.route === "/push");
		expect(pushes.map((c) => c.ops.length)).toEqual([2, 1]);
		// The ceiling bounds the ops, not the envelope, so allow the wrapper.
		for (const call of pushes) expect(call.bytes).toBeLessThan(4000 + 512);
	});

	it("keeps an exact-byte batch together and splits one byte below it", async () => {
		const ops = [makeOp(), makeOp()];
		const bytes = ops.reduce(
			(total, op) => total + Buffer.byteLength(JSON.stringify(op)),
			0,
		);
		const exact = await transportFor({ batchBytes: bytes }).push(ops);
		if (!exact.ok) throw exact.error;
		expect(calls.map((call) => call.ops.length)).toEqual([2]);
		calls = [];
		const below = await transportFor({ batchBytes: bytes - 1 }).push(ops);
		if (!below.ok) throw below.error;
		expect(calls.map((call) => call.ops.length)).toEqual([1, 1]);
	});

	it("sends one request when the batch fits", async () => {
		const transport = transportFor();

		const ack = await transport.push([makeOp(), makeOp(), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		expect(calls.filter((c) => c.route === "/push").length).toBe(1);
	});

	it("gives an oversized op its own request rather than dropping it", async () => {
		const transport = transportFor();

		const ack = await transport.push([makeOp(), fatOp(9000), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		const pushes = calls.filter((c) => c.route === "/push");
		expect(pushes.map((c) => c.ops.length)).toEqual([1, 1, 1]);
	});
});

// ============================================================
// Retry idempotency
// ============================================================

describe("retry", () => {
	it("retries the identical ops after a committed push loses its ack", async () => {
		const transport = transportFor({ maxAttempts: 3 });
		const ops = [makeOp(), makeOp()];
		loseAck = true;
		const ack = await transport.push(ops);
		if (!ack.ok) throw ack.error;
		expect(ack.value).toEqual({ accepted: 0, duplicates: 2, head: 2 });
		expect(calls.map((call) => call.ops)).toEqual([ops, ops]);
		expect(LocalRelay.ops(relay)).toHaveLength(2);
	});

	it("retries a transient 500 and lands the ops exactly once", async () => {
		const transport = transportFor({ maxAttempts: 3 });
		transientFailures = 2;

		const ack = await transport.push([makeOp(), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(2);
		expect(LocalRelay.ops(relay).length).toBe(2);
		expect(calls.filter((c) => c.route === "/push").length).toBe(3);
	});

	it("fails without quarantining when the network never answers", async () => {
		const transport = transportFor({ maxAttempts: 2 });
		await server.stop(true);

		const ack = await transport.push([makeOp(), makeOp()]);
		expect(ack.ok).toBe(false);

		const count = await withDb((db) => Oplog.quarantineCount(db));
		if (!count.ok) throw count.error;
		expect(count.value).toBe(0);
	});

	it("fails without quarantining or bisecting on 401", async () => {
		const transport = transportFor({ maxAttempts: 2, token: "wrong" });

		const ack = await transport.push([makeOp(), makeOp(), makeOp(), makeOp()]);
		expect(ack.ok).toBe(false);

		// Two attempts on the one chunk. No halving: a bad token is not a refusal
		// of the content, so walking down to singletons would be pure waste.
		expect(calls.filter((c) => c.route === "/push").length).toBe(2);
		const count = await withDb((db) => Oplog.quarantineCount(db));
		if (!count.ok) throw count.error;
		expect(count.value).toBe(0);
	});
});

// ============================================================
// Poison pill
// ============================================================

describe("quarantine", () => {
	it("bisects a mixed batch to isolate the poison op", async () => {
		// One chunk holding all four ops, so the offender has to be found by
		// halving — the case the server cannot fix without giving up atomicity.
		const transport = transportFor({ batchBytes: 1_000_000 });
		maxBodyBytes = 3000;

		const poison = fatOp(4000, { opId: "op-poison", rowId: "row-poison" });
		const ops = [makeOp(), poison, makeOp(), makeOp()];
		const ack = await transport.push(ops);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		expect(LocalRelay.ops(relay).length).toBe(3);
		// One request for the whole batch, then halves down to the singleton.
		expect(calls.filter((c) => c.route === "/push").length).toBeGreaterThan(2);

		const quarantined = await withDb((db) => Oplog.listQuarantined(db, 10));
		if (!quarantined.ok) throw quarantined.error;
		expect(quarantined.value.length).toBe(1);
		expect(quarantined.value[0]?.opId).toBe("op-poison");
		expect(quarantined.value[0]?.rowId).toBe("row-poison");
		expect(quarantined.value[0]?.bytes).toBeGreaterThan(4000);
		expect(quarantined.value[0]?.reason).toContain("500");
	});

	it("quarantines an op that was already alone in its chunk", async () => {
		// Chunking put the fat op on its own, so there is nothing to bisect.
		const transport = transportFor();
		maxBodyBytes = 3000;

		const ack = await transport.push([
			makeOp(),
			fatOp(4000, { opId: "op-poison" }),
			makeOp(),
		]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(2);
		const quarantined = await withDb((db) => Oplog.listQuarantined(db, 10));
		if (!quarantined.ok) throw quarantined.error;
		expect(quarantined.value.map((q) => q.opId)).toEqual(["op-poison"]);
	});

	it("advances the pushed watermark past a quarantined op", async () => {
		maxBodyBytes = 3000;

		// A real capture: one enormous description, then an ordinary task after it.
		const huge = await Planner.addTask(base, {
			title: "poison",
			description: "x".repeat(4000),
		});
		if (!huge.ok) throw huge.error;
		const next = await Planner.addTask(base, { title: "after the poison" });
		if (!next.ok) throw next.error;

		const before = await Sync.status(base);
		if (!before.ok) throw before.error;
		expect(before.value.pendingOps).toBe(2);

		const pushed = await Sync.push(base, transportFor());
		if (!pushed.ok) throw pushed.error;

		// The watermark cleared BOTH ops: this is the liveness property. Leaving it
		// where it was would re-offer the poison op on every pass forever.
		const after = await Sync.status(base);
		if (!after.ok) throw after.error;
		expect(after.value.pendingOps).toBe(0);
		expect(after.value.quarantinedOps).toBe(1);
		expect(after.value.quarantined[0]?.tbl).toBe("tasks");
		expect(pushed.value.pushed).toBe(1);
	});

	it("records a repeat refusal of the same op once", async () => {
		const transport = transportFor();
		maxBodyBytes = 3000;
		const poison = fatOp(4000, { opId: "op-poison" });

		await transport.push([poison]);
		await transport.push([poison]);

		const count = await withDb((db) => Oplog.quarantineCount(db));
		if (!count.ok) throw count.error;
		expect(count.value).toBe(1);
	});

	it("surfaces quarantine and pending counts together in status", async () => {
		maxBodyBytes = 3000;
		const huge = await Planner.addTask(base, {
			title: "poison",
			description: "x".repeat(4000),
		});
		if (!huge.ok) throw huge.error;

		const pushed = await Sync.push(base, transportFor());
		if (!pushed.ok) throw pushed.error;

		// A local write after the pass: pending and quarantined are independent.
		const later = await Planner.addTask(base, { title: "unpushed" });
		if (!later.ok) throw later.error;

		const status = await Sync.status(base);
		if (!status.ok) throw status.error;
		expect(status.value.quarantinedOps).toBe(1);
		expect(status.value.pendingOps).toBe(1);
		expect(status.value.quarantined.length).toBe(1);
	});
});

// ============================================================
// Reconstitution
// ============================================================

describe("pull reconstitution", () => {
	it("merges serverSeq into the verbatim payload", async () => {
		await seed(makeOp({ deviceId: OTHER, opId: "from-beta", rowId: "beta-1" }));
		const transport = transportFor();

		const page = await transport.pull(0, 500);
		if (!page.ok) throw page.error;

		expect(page.value.ops.length).toBe(1);
		expect(page.value.ops[0]?.opId).toBe("from-beta");
		expect(page.value.ops[0]?.serverSeq).toBe(1);
		expect(page.value.ops[0]?.payload?.id).toBe("beta-1");
		expect(page.value.ops[0]?.deviceId).toBe(OTHER);
	});

	it("preserves a column and an envelope key this build has never heard of", async () => {
		// What a newer device sends: an unknown key on the envelope, and an unknown
		// column inside the row snapshot. Default zod strips both, silently.
		const future: SyncOp = {
			...makeOp({
				deviceId: OTHER,
				opId: "from-future",
				rowId: "future-1",
				payload: taskRow("future-1", "t", { energy_level: "high" }),
			}),
			schemaVersion: 9,
		} as SyncOp & { schemaVersion: number };
		// The relay deliberately strips envelope extras; supply just this wire response.
		pullResponse = Response.json({
			ops: [{ serverSeq: 7, payload: JSON.stringify(future) }],
			throughSeq: 7,
			hasMore: false,
		});

		const page = await transportFor().pull(0, 500);
		if (!page.ok) throw page.error;

		const op = page.value.ops[0];
		expect(op?.payload?.energy_level).toBe("high");
		expect((op as unknown as { schemaVersion?: number })?.schemaVersion).toBe(
			9,
		);
	});

	it("withholds this device's own ops but still reports throughSeq", async () => {
		const transport = transportFor();
		await transport.push([makeOp(), makeOp()]);

		const page = await transport.pull(0, 500);
		if (!page.ok) throw page.error;

		// Every row in the window was ours: no ops, cursor still moves.
		expect(page.value.ops).toEqual([]);
		expect(page.value.throughSeq).toBe(2);
		expect(page.value.hasMore).toBe(false);
	});

	it("clamps limit to the server's maximum", async () => {
		const transport = transportFor();

		const page = await transport.pull(0, 5000);
		expect(page.ok).toBe(true);
		expect(calls[0]?.limit).toBe(1000);
	});

	it("rejects a non-positive limit without a request", async () => {
		const transport = transportFor();

		const page = await transport.pull(0, 0);
		expect(page.ok).toBe(false);
		expect(calls.length).toBe(0);
	});
});

// ============================================================
// Log reset
// ============================================================

describe("log reset", () => {
	it("rewinds the applied watermark when the remote head drops below it", async () => {
		const transport = transportFor();

		// Beta writes three ops; alpha pulls and applies them.
		for (let i = 0; i < 3; i++) {
			await seed(
				makeOp({ deviceId: OTHER, opId: `beta-${i}`, rowId: `beta-${i}` }),
			);
		}
		const pulled = await Sync.pull(base, transport);
		if (!pulled.ok) throw pulled.error;

		const caughtUp = await Sync.status(base);
		if (!caughtUp.ok) throw caughtUp.error;
		expect(caughtUp.value.lastAppliedSeq).toBe(3);

		// The log is wiped. Alpha pushes one op; head comes back as 1.
		relay = LocalRelay.create();
		await Planner.addTask(base, { title: "after the wipe" });
		const pushed = await Sync.push(base, transport);
		if (!pushed.ok) throw pushed.error;

		const after = await Sync.status(base);
		if (!after.ok) throw after.error;
		expect(after.value.lastAppliedSeq).toBe(0);
	});

	it("leaves the watermark alone when the head is ahead", async () => {
		const transport = transportFor();
		for (let i = 0; i < 3; i++) {
			await seed(
				makeOp({ deviceId: OTHER, opId: `beta-${i}`, rowId: `beta-${i}` }),
			);
		}
		const pulled = await Sync.pull(base, transport);
		if (!pulled.ok) throw pulled.error;

		await Planner.addTask(base, { title: "ordinary work" });
		const pushed = await Sync.push(base, transport);
		if (!pushed.ok) throw pushed.error;

		const after = await Sync.status(base);
		if (!after.ok) throw after.error;
		expect(after.value.lastAppliedSeq).toBe(3);
	});

	it("does not rewind when every op in the push was quarantined", async () => {
		const transport = transportFor();
		for (let i = 0; i < 3; i++) {
			await seed(
				makeOp({ deviceId: OTHER, opId: `beta-${i}`, rowId: `beta-${i}` }),
			);
		}
		const pulled = await Sync.pull(base, transport);
		if (!pulled.ok) throw pulled.error;

		// No head was ever observed, so head 0 must not read as a reset.
		maxBodyBytes = 100;
		const ack = await transport.push([fatOp(4000)]);
		if (!ack.ok) throw ack.error;
		expect(ack.value.head).toBe(0);

		const after = await Sync.status(base);
		if (!after.ok) throw after.error;
		expect(after.value.lastAppliedSeq).toBe(3);
	});
});
