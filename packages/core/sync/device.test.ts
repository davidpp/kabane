/**
 * Sync — Device Wiring
 *
 * Settings come from the host through the `syncSettings` runtime port; the
 * tests configure that port directly instead of writing a config file.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../result";
import { withDb } from "../runtime";
import { type SyncConfig, SyncConfigSchema } from "../schemas";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { configureTestRuntime } from "../testing";
import { SyncDevice } from "./device";

let base: string;

/** Point the runtime's sync settings at an in-memory block. */
const useSettings = (raw: Partial<SyncConfig>) => {
	const parsed = SyncConfigSchema.safeParse(raw);
	if (!parsed.success) throw new Error(parsed.error.message);
	const settings = parsed.data;
	configureTestRuntime("", { syncSettings: async () => ok(settings) });
};

const stateOf = async () => {
	const result = await withDb(base, Oplog.getState);
	if (!result.ok) throw result.error;
	if (!result.value.ok) throw result.value.error;
	return result.value.value;
};

beforeEach(async () => {
	base = join(tmpdir(), `planner-device-${crypto.randomUUID()}`);
	mkdirSync(base, { recursive: true });
	configureTestRuntime();

	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
});

afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

describe("settings", () => {
	it("reports sync off when the host configured nothing", async () => {
		const settings = await SyncDevice.settings();
		if (!settings.ok) throw settings.error;

		expect(settings.value.enabled).toBe(false);
		expect(settings.value.batchBytes).toBe(262144);
	});

	it("returns the host's sync block with defaults filled", async () => {
		useSettings({ enabled: true, url: "https://s.workers.dev", token: "t" });

		const settings = await SyncDevice.settings();
		if (!settings.ok) throw settings.error;
		expect(settings.value.enabled).toBe(true);
		expect(settings.value.url).toBe("https://s.workers.dev");
		expect(settings.value.batchBytes).toBe(262144);
	});
});

describe("arm", () => {
	it("writes the device identity once and reuses it after", async () => {
		const first = await SyncDevice.arm(base, "device-one");
		if (!first.ok) throw first.error;
		expect(first.value).toBe("device-one");

		// Config cannot rename a device: the remote would treat it as new and hand
		// back its own ops.
		const second = await SyncDevice.arm(base, "device-two");
		if (!second.ok) throw second.error;
		expect(second.value).toBe("device-one");
		expect((await stateOf())?.deviceId).toBe("device-one");
	});

	it("mints an identity when config supplies none", async () => {
		const armed = await SyncDevice.arm(base);
		if (!armed.ok) throw armed.error;
		expect(armed.value.length).toBeGreaterThan(0);
		expect((await stateOf())?.deviceId).toBe(armed.value);
	});
});

describe("connect", () => {
	it("refuses when sync is disabled", async () => {
		const connected = await SyncDevice.connect(base);
		expect(connected.ok).toBe(false);
		if (connected.ok) return;
		expect(connected.error.message).toContain("disabled");
		// Nothing armed: a disabled device must not start capturing.
		expect(await stateOf()).toBeUndefined();
	});

	it("refuses when the url or token is missing", async () => {
		const connected = await SyncDevice.connect(base, {
			settings: { enabled: true, batchBytes: 262144 },
		});
		expect(connected.ok).toBe(false);
		if (!connected.ok) expect(connected.error.message).toContain("url");
	});

	it("arms capture as a side effect of the first connection", async () => {
		const connected = await SyncDevice.connect(base, {
			settings: {
				enabled: true,
				url: "https://s.workers.dev",
				token: "t",
				deviceId: "device-alpha",
				batchBytes: 262144,
			},
		});
		if (!connected.ok) throw connected.error;

		expect(connected.value.deviceId).toBe("device-alpha");
		expect((await stateOf())?.deviceId).toBe("device-alpha");
	});
});
