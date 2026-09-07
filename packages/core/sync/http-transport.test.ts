/**
 * Planner Sync — HTTP Transport
 *
 * Against a stub server, never a deployed Worker. The stub models the three
 * behaviours of the real Durable Object that the transport is built around:
 * verbatim payload storage (unknown keys survive), `ON CONFLICT(op_id) DO
 * NOTHING` idempotency, and — because a skipped insert still burns an
 * AUTOINCREMENT value — `server_seq` GAPS after every duplicate.
 *
 * The stub mirrors `workers/planner-sync/src/{wire,oplog}.ts`. It is a second
 * implementation on purpose: that Worker is not a workspace package (its vitest
 * 4 must not meet the dashboard's vitest 3), so importing it here would be a new
 * cross-boundary dependency. JJAK-1075 closes the drift with a wrangler-dev E2E.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";
import type { SyncOp } from "../schemas";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { type FetchLike, HttpTransport } from "./http-transport";
import { Sync } from "./namespace";

// ============================================================
// Stub Server
// ============================================================

const DEVICE = "device-alpha";
const OTHER = "device-beta";
const TOKEN = "test-token";
const URL_BASE = "https://planner-sync.test";

/** Mirrors `WireOpSchema`: only the two keys the server uses, rest opaque. */
const WireOpSchema = z
	.object({ opId: z.string().min(1), deviceId: z.string().min(1) })
	.passthrough();

type Stored = { serverSeq: number; deviceId: string; payload: string };

type StubServer = {
	fetchImpl: FetchLike;
	/** Requests seen, oldest first. */
	calls: { route: string; ops: number; bytes: number }[];
	rows: () => Stored[];
	head: () => number;
	/** Insert directly, as another device would have. */
	seed: (op: SyncOp) => void;
	/** Drop the log and restart numbering — a wipe or a bookmark restore. */
	wipe: () => void;
	/** Refuse any request whose body exceeds this, the way the 2 MB cap does. */
	maxBodyBytes: number;
	/** Fail the next N requests without a response, the way a dead link does. */
	networkFailures: number;
	/** Return 500 for the next N requests, then behave. */
	transientFailures: number;
	/** Answer 401 to everything. */
	unauthorized: boolean;
};

const createStub = (): StubServer => {
	const byOpId = new Map<string, Stored>();
	// AUTOINCREMENT, not a row count: a conflicting insert burns a value.
	let nextSeq = 1;

	const server: StubServer = {
		calls: [],
		rows: () => [...byOpId.values()].sort((a, b) => a.serverSeq - b.serverSeq),
		head: () =>
			[...byOpId.values()].reduce(
				(max, row) => Math.max(max, row.serverSeq),
				0,
			),
		seed: (op: SyncOp) => {
			const serverSeq = nextSeq++;
			byOpId.set(op.opId, {
				serverSeq,
				deviceId: op.deviceId,
				payload: JSON.stringify(op),
			});
		},
		wipe: () => {
			byOpId.clear();
			nextSeq = 1;
		},
		maxBodyBytes: Number.POSITIVE_INFINITY,
		networkFailures: 0,
		transientFailures: 0,
		unauthorized: false,
		fetchImpl: async (url, init) => {
			const route = new URL(url).pathname;
			const bytes = Buffer.byteLength(init.body, "utf8");
			const body = JSON.parse(init.body) as Record<string, unknown>;
			// Recorded before any rejection: the assertions are about how many
			// requests the transport chose to make, including the refused ones.
			server.calls.push({
				route,
				ops: Array.isArray(body.ops) ? body.ops.length : 0,
				bytes,
			});

			if (server.networkFailures > 0) {
				server.networkFailures--;
				throw new Error("connect ECONNREFUSED");
			}

			if (
				server.unauthorized ||
				init.headers.Authorization !== `Bearer ${TOKEN}`
			) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}

			if (route === "/push") {
				const parsed = z
					.object({
						deviceId: z.string(),
						name: z.string().optional(),
						ops: z.array(WireOpSchema),
					})
					.safeParse(body);
				if (!parsed.success) {
					return Response.json(
						{ error: parsed.error.message },
						{ status: 400 },
					);
				}

				if (server.transientFailures > 0) {
					server.transientFailures--;
					return Response.json({ error: "storage busy" }, { status: 500 });
				}

				// The whole batch is ONE bound parameter, so an oversized batch is
				// refused atomically — nothing is inserted.
				if (bytes > server.maxBodyBytes) {
					return Response.json(
						{ error: "too large for a single bound parameter" },
						{ status: 500 },
					);
				}

				let accepted = 0;
				for (const op of parsed.data.ops) {
					const serverSeq = nextSeq++;
					if (byOpId.has(op.opId)) continue; // ON CONFLICT DO NOTHING
					byOpId.set(op.opId, {
						serverSeq,
						deviceId: op.deviceId,
						payload: JSON.stringify(op),
					});
					accepted++;
				}

				return Response.json({
					accepted,
					duplicates: parsed.data.ops.length - accepted,
					head: server.head(),
				});
			}

			if (route === "/pull") {
				const parsed = z
					.object({
						deviceId: z.string(),
						sinceSeq: z.number(),
						limit: z.number().int().positive().max(1000),
					})
					.safeParse(body);
				if (!parsed.success) {
					return Response.json(
						{ error: parsed.error.message },
						{ status: 400 },
					);
				}

				// Window BEFORE the device filter — throughSeq describes the window.
				const window = server
					.rows()
					.filter((row) => row.serverSeq > parsed.data.sinceSeq)
					.slice(0, parsed.data.limit);
				const throughSeq = window.at(-1)?.serverSeq ?? parsed.data.sinceSeq;

				return Response.json({
					ops: window
						.filter((row) => row.deviceId !== parsed.data.deviceId)
						.map((row) => ({ serverSeq: row.serverSeq, payload: row.payload })),
					throughSeq,
					hasMore: server.head() > throughSeq,
				});
			}

			return Response.json({ error: "not found" }, { status: 404 });
		},
	};

	return server;
};

// ============================================================
// Harness
// ============================================================

let base: string;
let stub: StubServer;

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const transportFor = (
	overrides: { maxAttempts?: number; batchBytes?: number } = {},
) =>
	HttpTransport.create(base, {
		url: URL_BASE,
		token: TOKEN,
		deviceId: DEVICE,
		batchBytes: overrides.batchBytes ?? 4096,
		maxAttempts: overrides.maxAttempts ?? 2,
		fetchImpl: stub.fetchImpl,
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

	stub = createStub();
});

afterEach(() => {
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
		const pushes = stub.calls.filter((c) => c.route === "/push");
		expect(pushes.map((c) => c.ops)).toEqual([2, 1]);
		// The ceiling bounds the ops, not the envelope, so allow the wrapper.
		for (const call of pushes) expect(call.bytes).toBeLessThan(4000 + 512);
	});

	it("sends one request when the batch fits", async () => {
		const transport = transportFor();

		const ack = await transport.push([makeOp(), makeOp(), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		expect(stub.calls.filter((c) => c.route === "/push").length).toBe(1);
	});

	it("gives an oversized op its own request rather than dropping it", async () => {
		const transport = transportFor();

		const ack = await transport.push([makeOp(), fatOp(9000), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		const pushes = stub.calls.filter((c) => c.route === "/push");
		expect(pushes.map((c) => c.ops)).toEqual([1, 1, 1]);
	});
});

// ============================================================
// Retry idempotency
// ============================================================

describe("retry", () => {
	it("reuses opId so a retried push is a duplicate, not a second row", async () => {
		const transport = transportFor({ maxAttempts: 3 });
		const op = makeOp();

		// First attempt commits, then the ack is lost.
		stub.transientFailures = 0;
		const first = await transport.push([op]);
		if (!first.ok) throw first.error;
		expect(first.value.accepted).toBe(1);

		// Same op, same opId — the server must recognize it.
		const second = await transport.push([op]);
		if (!second.ok) throw second.error;
		expect(second.value.accepted).toBe(0);
		expect(second.value.duplicates).toBe(1);
		expect(stub.rows().length).toBe(1);
	});

	it("retries a transient 500 and lands the ops exactly once", async () => {
		const transport = transportFor({ maxAttempts: 3 });
		stub.transientFailures = 2;

		const ack = await transport.push([makeOp(), makeOp()]);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(2);
		expect(stub.rows().length).toBe(2);
		expect(stub.calls.filter((c) => c.route === "/push").length).toBe(3);
	});

	it("burns a server_seq per duplicate, so the log has gaps", async () => {
		const transport = transportFor();
		const first = makeOp();

		await transport.push([first]);
		await transport.push([first, makeOp()]);

		const seqs = stub.rows().map((row) => row.serverSeq);
		// 1 accepted, then a conflict burns 2, so the new op lands at 3.
		expect(seqs).toEqual([1, 3]);
		expect(seqs.length).toBeLessThan(seqs[seqs.length - 1] ?? 0);
	});

	it("fails without quarantining when the network never answers", async () => {
		const transport = transportFor({ maxAttempts: 2 });
		stub.networkFailures = 10;

		const ack = await transport.push([makeOp(), makeOp()]);
		expect(ack.ok).toBe(false);

		const count = await withDb((db) => Oplog.quarantineCount(db));
		if (!count.ok) throw count.error;
		expect(count.value).toBe(0);
	});

	it("fails without quarantining or bisecting on 401", async () => {
		const transport = transportFor({ maxAttempts: 2 });
		stub.unauthorized = true;

		const ack = await transport.push([makeOp(), makeOp(), makeOp(), makeOp()]);
		expect(ack.ok).toBe(false);

		// Two attempts on the one chunk. No halving: a bad token is not a refusal
		// of the content, so walking down to singletons would be pure waste.
		expect(stub.calls.filter((c) => c.route === "/push").length).toBe(2);
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
		stub.maxBodyBytes = 3000;

		const poison = fatOp(4000, { opId: "op-poison", rowId: "row-poison" });
		const ops = [makeOp(), poison, makeOp(), makeOp()];
		const ack = await transport.push(ops);
		if (!ack.ok) throw ack.error;

		expect(ack.value.accepted).toBe(3);
		expect(stub.rows().length).toBe(3);
		// One request for the whole batch, then halves down to the singleton.
		expect(
			stub.calls.filter((c) => c.route === "/push").length,
		).toBeGreaterThan(2);

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
		stub.maxBodyBytes = 3000;

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
		stub.maxBodyBytes = 3000;

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
		stub.maxBodyBytes = 3000;
		const poison = fatOp(4000, { opId: "op-poison" });

		await transport.push([poison]);
		await transport.push([poison]);

		const count = await withDb((db) => Oplog.quarantineCount(db));
		if (!count.ok) throw count.error;
		expect(count.value).toBe(1);
	});

	it("surfaces quarantine and pending counts together in status", async () => {
		stub.maxBodyBytes = 3000;
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
		stub.seed(makeOp({ deviceId: OTHER, opId: "from-beta", rowId: "beta-1" }));
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
		stub.seed(future);

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
	});

	it("rejects a non-positive limit without a request", async () => {
		const transport = transportFor();

		const page = await transport.pull(0, 0);
		expect(page.ok).toBe(false);
		expect(stub.calls.length).toBe(0);
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
			stub.seed(
				makeOp({ deviceId: OTHER, opId: `beta-${i}`, rowId: `beta-${i}` }),
			);
		}
		const pulled = await Sync.pull(base, transport);
		if (!pulled.ok) throw pulled.error;

		const caughtUp = await Sync.status(base);
		if (!caughtUp.ok) throw caughtUp.error;
		expect(caughtUp.value.lastAppliedSeq).toBe(3);

		// The log is wiped. Alpha pushes one op; head comes back as 1.
		stub.wipe();
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
			stub.seed(
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
			stub.seed(
				makeOp({ deviceId: OTHER, opId: `beta-${i}`, rowId: `beta-${i}` }),
			);
		}
		const pulled = await Sync.pull(base, transport);
		if (!pulled.ok) throw pulled.error;

		// No head was ever observed, so head 0 must not read as a reset.
		stub.maxBodyBytes = 100;
		const ack = await transport.push([fatOp(4000)]);
		if (!ack.ok) throw ack.error;
		expect(ack.value.head).toBe(0);

		const after = await Sync.status(base);
		if (!after.ok) throw after.error;
		expect(after.value.lastAppliedSeq).toBe(3);
	});
});

// ============================================================
// Over real HTTP
// ============================================================

/**
 * The same wire contract over a local `Bun.serve`, through the DEFAULT
 * `globalThis.fetch`. Every other test here substitutes `fetchImpl`, which
 * leaves the un-stubbed path — URL joining, the Authorization header, real JSON
 * — unexercised, and that path is the one production uses.
 */
describe("over real HTTP", () => {
	it("round-trips a push and a pull against a local server", async () => {
		const stored: Stored[] = [];

		const server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				// The server answers nothing but 401 without the right Bearer header,
				// so a successful round trip IS the proof the header was sent.
				if (request.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
					return Response.json({ error: "unauthorized" }, { status: 401 });
				}

				const { pathname } = new URL(request.url);
				const body = (await request.json()) as Record<string, unknown>;

				if (pathname === "/push") {
					for (const op of (body.ops ?? []) as { opId: string }[]) {
						stored.push({
							serverSeq: stored.length + 1,
							deviceId: OTHER,
							payload: JSON.stringify(op),
						});
					}
					return Response.json({
						accepted: stored.length,
						duplicates: 0,
						head: stored.length,
					});
				}

				return Response.json({
					ops: stored.map((row) => ({
						serverSeq: row.serverSeq,
						payload: row.payload,
					})),
					throughSeq: stored.length,
					hasMore: false,
				});
			},
		});

		try {
			// A trailing slash on the base URL must not produce a "//push" path.
			const transport = HttpTransport.create(base, {
				url: `http://localhost:${server.port}/`,
				token: TOKEN,
				deviceId: DEVICE,
			});

			const ack = await transport.push([makeOp({ opId: "live-1" })]);
			if (!ack.ok) throw ack.error;
			expect(ack.value.accepted).toBe(1);

			const page = await transport.pull(0, 500);
			if (!page.ok) throw page.error;
			expect(page.value.ops[0]?.opId).toBe("live-1");
			expect(page.value.ops[0]?.serverSeq).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	it("reports a wrong token as an error, and quarantines nothing", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: async () =>
				Response.json({ error: "unauthorized" }, { status: 401 }),
		});

		try {
			const transport = HttpTransport.create(base, {
				url: `http://localhost:${server.port}`,
				token: "wrong",
				deviceId: DEVICE,
				maxAttempts: 1,
			});

			const ack = await transport.push([makeOp()]);
			expect(ack.ok).toBe(false);
			if (!ack.ok) expect(ack.error.message).toContain("401");

			const count = await withDb((db) => Oplog.quarantineCount(db));
			if (!count.ok) throw count.error;
			expect(count.value).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});
