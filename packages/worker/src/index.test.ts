import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HUMAN, withAccess } from "./test-access";

describe("kabane-worker", () => {
	it("answers /health to a verified identity, naming the actor", async () => {
		const res = await SELF.fetch("https://kabane.test/health", {
			headers: withAccess(HUMAN),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			service: "kabane-worker",
			actor: "cabane://actor/human/david",
		});
	});

	it("refuses /health without an assertion", async () => {
		const res = await SELF.fetch("https://kabane.test/health");
		expect(res.status).toBe(401);
	});

	it("answers 404 for an unknown route once authenticated", async () => {
		const res = await SELF.fetch("https://kabane.test/anything", {
			headers: withAccess(HUMAN),
		});
		expect(res.status).toBe(404);
	});

	it("binds both Durable Object classes", async () => {
		const log = env.KABANE_LOG.getByName("test");
		const hub = env.KABANE_HUB.getByName("test");
		expect(
			(await log.pull({ deviceId: "probe", sinceSeq: 0, limit: 1 })).ok,
		).toBe(true);
		expect(await hub.ping()).toBe("hub");
	});
});
