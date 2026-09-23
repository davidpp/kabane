import { describe, expect, test } from "bun:test";
import { buildConfig } from "./init";

const BASE = { actor: "cabane://actor/human/ada", deviceId: "mbp" };

describe("buildConfig", () => {
	test("a local device: sync off, no db block", () => {
		const built = buildConfig(BASE);
		expect(built.ok && built.value).toEqual({
			...BASE,
			sync: expect.objectContaining({ enabled: false, deviceId: "mbp" }),
		});
	});

	test("sync is on only with both the url and the token", () => {
		const half = buildConfig({ ...BASE, syncUrl: "https://hub.example" });
		expect(half.ok && half.value.sync.enabled).toBe(false);
		const both = buildConfig({
			...BASE,
			syncUrl: "https://hub.example",
			syncToken: "t",
		});
		expect(both.ok && both.value.sync.enabled).toBe(true);
	});

	test("half an Access service token is refused", () => {
		expect(buildConfig({ ...BASE, accessClientId: "id" }).ok).toBe(false);
	});

	test("an empty actor fails the schema", () => {
		expect(buildConfig({ ...BASE, actor: "" }).ok).toBe(false);
	});
});
