import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HUMAN, withAccess } from "./test-access";
import { MAX_PULL_LIMIT, type PullPage, type PushAck } from "./wire";

// `SELF` is marked deprecated in favour of `ctx.exports` from
// "cloudflare:workers", which needs a `Cloudflare.GlobalProps` declaration to be
// typed. Not worth the machinery while pinned to pool-workers 0.18.
const TOKEN = env.SYNC_TOKEN ?? "";

const call = (
	path: string,
	body: unknown,
	init: { token?: string | null; method?: string } = {},
): Promise<Response> => {
	const { token = TOKEN, method = "POST" } = init;
	// Every log call carries a valid Access assertion: these tests are about the
	// log's own bearer check, which sits BEHIND Access (see access.test.ts).
	const headers = withAccess(HUMAN, { "Content-Type": "application/json" });
	if (token !== null) headers.set("Authorization", `Bearer ${token}`);

	return SELF.fetch(`https://cabane.test${path}`, {
		method,
		headers,
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});
};

const pushOps = (deviceId: string, opIds: string[]) =>
	call("/push", {
		deviceId,
		ops: opIds.map((opId) => ({ opId, deviceId, tbl: "tasks" })),
	});

describe("auth", () => {
	it("rejects a request with no token", async () => {
		const res = await call(
			"/push",
			{ deviceId: "a", ops: [] },
			{ token: null },
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("rejects a wrong token", async () => {
		const res = await call(
			"/push",
			{ deviceId: "a", ops: [] },
			{ token: "not-the-token" },
		);

		expect(res.status).toBe(401);
	});

	it("rejects a token of the right length but wrong bytes", async () => {
		const wrong = `${TOKEN.slice(0, -1)}X`;

		expect(wrong.length).toBe(TOKEN.length);
		expect(
			(await call("/push", { deviceId: "a", ops: [] }, { token: wrong }))
				.status,
		).toBe(401);
	});

	it("rejects a non-Bearer scheme", async () => {
		const res = await SELF.fetch("https://cabane.test/push", {
			method: "POST",
			headers: withAccess(HUMAN, { Authorization: `Basic ${TOKEN}` }),
			body: "{}",
		});

		expect(res.status).toBe(401);
	});

	it("checks Access before the route and the body", async () => {
		// Proves auth runs before anything can reach a stub: a request that is also
		// unroutable and unparseable still answers 401, not 404 or 400.
		const res = await SELF.fetch("https://cabane.test/nope", {
			method: "GET",
			body: undefined,
		});

		expect(res.status).toBe(401);
	});

	it("checks the bearer before the body on a log route", async () => {
		const res = await SELF.fetch("https://cabane.test/push", {
			method: "POST",
			headers: withAccess(HUMAN),
			body: "{ not json",
		});

		expect(res.status).toBe(401);
	});

	it("accepts the configured token", async () => {
		expect((await call("/push", { deviceId: "a", ops: [] })).status).toBe(200);
	});
});

describe("routing", () => {
	it("rejects a non-POST method", async () => {
		const res = await call("/push", null, { method: "GET" });

		expect(res.status).toBe(405);
	});

	it("404s an unknown path", async () => {
		expect((await call("/lease", {})).status).toBe(404);
	});

	it("400s a body that is not JSON", async () => {
		const res = await SELF.fetch("https://cabane.test/push", {
			method: "POST",
			headers: withAccess(HUMAN, { Authorization: `Bearer ${TOKEN}` }),
			body: "{ not json",
		});

		expect(res.status).toBe(400);
	});

	it("400s ops missing the two fields the server needs", async () => {
		const res = await call("/push", {
			deviceId: "a",
			ops: [{ tbl: "tasks", rowId: "r1" }],
		});

		expect(res.status).toBe(400);
	});

	it("400s a pull limit outside the allowed range", async () => {
		const base = { deviceId: "a", sinceSeq: 0 };

		expect((await call("/pull", { ...base, limit: 0 })).status).toBe(400);
		expect((await call("/pull", { ...base, limit: -1 })).status).toBe(400);
		expect((await call("/pull", { ...base, limit: 1.5 })).status).toBe(400);
		expect(
			(await call("/pull", { ...base, limit: MAX_PULL_LIMIT + 1 })).status,
		).toBe(400);
		expect(
			(await call("/pull", { ...base, limit: MAX_PULL_LIMIT })).status,
		).toBe(200);
	});

	it("400s a negative sinceSeq", async () => {
		const res = await call("/pull", {
			deviceId: "a",
			sinceSeq: -1,
			limit: 10,
		});

		expect(res.status).toBe(400);
	});
});

/**
 * Every HTTP test shares one log — the Worker routes to a single DO instance by
 * name, and pool-workers 0.18 no longer rolls storage back between tests (the
 * `isolatedStorage` option is gone from the vitest-4 plugin API). So: unique
 * `opId`s per test, and assertions relative to the head the push reported.
 */
describe("round trip", () => {
	it("pushes from one device and pulls on the other", async () => {
		const pushed = await pushOps("device-a", ["rt-1", "rt-2"]);
		expect(pushed.status).toBe(200);
		const ack = await pushed.json<PushAck>();
		expect(ack).toMatchObject({ accepted: 2, duplicates: 0 });

		const pulled = await call("/pull", {
			deviceId: "device-b",
			sinceSeq: ack.head - 2,
			limit: 10,
		});
		const page = await pulled.json<PullPage>();

		expect(page.throughSeq).toBe(ack.head);
		expect(page.hasMore).toBe(false);
		expect(page.ops.map((o) => o.serverSeq)).toEqual([ack.head - 1, ack.head]);
		expect(page.ops.map((o) => JSON.parse(o.payload).opId)).toEqual([
			"rt-1",
			"rt-2",
		]);
	});

	it("reports duplicates on a replayed push", async () => {
		const first = await (
			await pushOps("device-a", ["replay-1"])
		).json<PushAck>();
		expect(first.accepted).toBe(1);

		const replay = await (
			await pushOps("device-a", ["replay-1"])
		).json<PushAck>();

		expect(replay).toEqual({
			accepted: 0,
			duplicates: 1,
			head: first.head,
		});
	});
});
