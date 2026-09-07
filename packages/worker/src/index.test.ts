import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("cabane-worker", () => {
	it("answers /health", async () => {
		const res = await SELF.fetch("https://cabane.test/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, service: "cabane-worker" });
	});

	it("rejects other routes", async () => {
		const res = await SELF.fetch("https://cabane.test/anything");
		expect(res.status).toBe(404);
	});

	it("binds both Durable Object classes", async () => {
		const log = env.CABANE_LOG.getByName("test");
		const hub = env.CABANE_HUB.getByName("test");
		expect(await log.ping()).toBe("log");
		expect(await hub.ping()).toBe("hub");
	});
});
