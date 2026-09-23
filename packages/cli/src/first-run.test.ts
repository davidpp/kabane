import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "./config";
import { type Installer, outcomeOf, setupDeps, tildePath } from "./first-run";

const ROOT = join(tmpdir(), `cabane-first-run-${crypto.randomUUID()}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const installer: Installer = {
	detect: async () => [{ id: "claude", label: "Claude Code" }],
	narrowed: () => false,
	install: async (ids) => ids.map((id) => ({ id, status: "installed" })),
};

describe("setupDeps", () => {
	test("prefills the device and the detected harnesses", async () => {
		const deps = await setupDeps(join(ROOT, "home-defaults"), installer);
		expect(deps.defaults.harnesses).toEqual([
			{ id: "claude", label: "Claude Code" },
		]);
		expect(deps.defaults.device.length).toBeGreaterThan(0);
		expect(deps.defaults.configPath).toBe(
			tildePath(configPath(join(ROOT, "home-defaults"))),
		);
	});

	test("tells install turned off apart from no harness installed", async () => {
		const none = { ...installer, detect: async () => [] };
		const off = await setupDeps(join(ROOT, "home-off"), {
			...none,
			narrowed: () => true,
		});
		expect(off.defaults.installOff).toBe(true);
		const absent = await setupDeps(join(ROOT, "home-absent"), none);
		expect(absent.defaults.installOff).toBe(false);
		const found = await setupDeps(join(ROOT, "home-found"), {
			...installer,
			narrowed: () => true,
		});
		expect(found.defaults.installOff).toBe(false);
	});

	test("save writes a local-only config, then refuses to overwrite it", async () => {
		const home = join(ROOT, "home-save");
		const deps = await setupDeps(home, installer);
		const plan = {
			actor: "cabane://actor/human/ada",
			deviceId: "mbp",
			install: [],
		};
		const saved = await deps.save(plan);
		expect(saved).toEqual({ ok: true, value: tildePath(configPath(home)) });
		const config = loadConfig(home);
		expect(config.ok && config.value.actor).toBe("cabane://actor/human/ada");
		expect(config.ok && config.value.sync.enabled).toBe(false);
		expect((await deps.save(plan)).ok).toBe(false);
	});
});

describe("tildePath", () => {
	test("shortens a path under the home directory, and only that", () => {
		expect(tildePath("/Users/alex/.cabane/config.json", "/Users/alex")).toBe(
			"~/.cabane/config.json",
		);
		expect(tildePath("/Users/alexa/config.json", "/Users/alex")).toBe(
			"/Users/alexa/config.json",
		);
	});
});

describe("outcomeOf", () => {
	test("each install report reads as installed, already, or failed with the reason", () => {
		expect(outcomeOf({ harness: "claude", status: "installed" })).toEqual({
			id: "claude",
			status: "installed",
		});
		expect(outcomeOf({ harness: "codex", status: "present" })).toEqual({
			id: "codex",
			status: "already",
		});
		expect(outcomeOf({ harness: "gemini", status: "missing" }).status).toBe(
			"failed",
		);
		expect(
			outcomeOf({ harness: "gemini", status: "failed", error: "auth needed" }),
		).toEqual({ id: "gemini", status: "failed", message: "auth needed" });
	});
});
