import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, harnessMode, loadConfig } from "./config";

let home = "";
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kabane-config-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const load = (extra: Record<string, unknown>) => {
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "cabane://actor/human/t",
			deviceId: "d",
			...extra,
		}),
	);
	return loadConfig(home);
};

describe("harness.mode", () => {
	it("is auto when the config names none", () => {
		const config = load({});
		if (!config.ok) throw config.error;
		expect(harnessMode(config.value)).toBe("auto");
	});

	it("turns the auto mode off with default", () => {
		const config = load({ harness: { mode: "default" } });
		if (!config.ok) throw config.error;
		expect(harnessMode(config.value)).toBe("default");
	});

	it("refuses a harness's own mode id: it is not a kabane setting", () => {
		expect(load({ harness: { mode: "bypassPermissions" } }).ok).toBe(false);
	});
});
