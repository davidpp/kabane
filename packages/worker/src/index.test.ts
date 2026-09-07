import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("cabane-worker", () => {
	it("answers /health", async () => {
		const res = await SELF.fetch("https://cabane.test/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, service: "cabane-worker" });
	});

	it("hides other routes behind the bearer check", async () => {
		const res = await SELF.fetch("https://cabane.test/anything");
		expect(res.status).toBe(401);
	});

	it("binds both Durable Object classes", async () => {
		const log = env.CABANE_LOG.getByName("test");
		const hub = env.CABANE_HUB.getByName("test");
		expect(
			(await log.pull({ deviceId: "probe", sinceSeq: 0, limit: 1 })).ok,
		).toBe(true);
		expect(await hub.ping()).toBe("hub");
	});
});
