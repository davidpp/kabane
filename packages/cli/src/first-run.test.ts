import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, SCOPE_FILE } from "./config";
import { type Installer, outcomeOf, setupDeps } from "./first-run";

const ROOT = join(tmpdir(), `cabane-first-run-${crypto.randomUUID()}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const installer: Installer = {
	detect: async () => [{ id: "claude", label: "Claude Code" }],
	install: async (ids) => ids.map((id) => ({ id, status: "installed" })),
};

const gitRepo = (name: string, remote = true): string => {
	const dir = join(ROOT, name);
	mkdirSync(dir, { recursive: true });
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	if (remote)
		Bun.spawnSync(
			["git", "remote", "add", "origin", `git@github.com:acme/${name}.git`],
			{ cwd: dir },
		);
	return dir;
};

describe("setupDeps", () => {
	test("prefills the device, the detected harnesses and the git repo", async () => {
		const home = join(ROOT, "home-defaults");
		const deps = await setupDeps(home, gitRepo("widgets"), installer);
		expect(deps.defaults.harnesses).toEqual([
			{ id: "claude", label: "Claude Code" },
		]);
		expect(deps.defaults.repo?.scopeId).toBe("github.com/acme/widgets");
		expect(deps.defaults.device.length).toBeGreaterThan(0);
	});

	test("outside any project there is no repo to pin", async () => {
		const home = join(ROOT, "home-none");
		const outside = join(ROOT, "plain");
		mkdirSync(outside, { recursive: true });
		const deps = await setupDeps(home, outside, installer);
		expect(deps.defaults.repo).toBeNull();
	});

	test("save writes a local-only config and the pin, then refuses to overwrite it", async () => {
		const home = join(ROOT, "home-save");
		// No remote and no commit: detection caches no pin of its own, so the file is the plan's.
		const repo = gitRepo("gadgets", false);
		const deps = await setupDeps(home, repo, installer);
		const plan = {
			actor: "cabane://actor/human/ada",
			deviceId: "mbp",
			install: [],
			pin: deps.defaults.repo,
		};
		const saved = await deps.save(plan);
		expect(saved).toEqual({ ok: true, value: configPath(home) });
		const config = loadConfig(home);
		expect(config.ok && config.value.actor).toBe("cabane://actor/human/ada");
		expect(config.ok && config.value.sync.enabled).toBe(false);
		expect(readFileSync(join(repo, SCOPE_FILE), "utf8")).toBe(
			`${deps.defaults.repo?.scopeId}\n`,
		);
		expect((await deps.save(plan)).ok).toBe(false);
	});
});

describe("outcomeOf", () => {
	test("each install report reads as installed, already, or failed with the reason", () => {
		expect(outcomeOf({ harness: "claude", status: "installed" })).toEqual({
			id: "claude",
			status: "installed",
			message: "as cabane://actor/agent/claude",
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
