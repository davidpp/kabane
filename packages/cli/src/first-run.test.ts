import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { parseArgs } from "./args";
import { configPath, loadConfig } from "./config";
import { openContext } from "./context";
import {
	firstIssueBrief,
	type Installer,
	outcomeOf,
	setupDeps,
	tildePath,
} from "./first-run";

const ROOT = join(tmpdir(), `cabane-first-run-${crypto.randomUUID()}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// Not a project: nothing above the system temp directory is a git repo or carries a `.kabane` pin.
const NOWHERE = ROOT;

const gitRepo = (name: string): string => {
	const dir = join(ROOT, name);
	mkdirSync(dir, { recursive: true });
	GitFixture.run(dir, ["init", "-q"]);
	return dir;
};

const installer: Installer = {
	detect: async () => [{ id: "claude", label: "Claude Code" }],
	narrowed: () => false,
	install: async (ids) => ids.map((id) => ({ id, status: "installed" })),
};

describe("setupDeps", () => {
	test("prefills the device and the detected harnesses", async () => {
		const deps = await setupDeps(
			join(ROOT, "home-defaults"),
			NOWHERE,
			installer,
		);
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
		const off = await setupDeps(join(ROOT, "home-off"), NOWHERE, {
			...none,
			narrowed: () => true,
		});
		expect(off.defaults.installOff).toBe(true);
		const absent = await setupDeps(join(ROOT, "home-absent"), NOWHERE, none);
		expect(absent.defaults.installOff).toBe(false);
		const found = await setupDeps(join(ROOT, "home-found"), NOWHERE, {
			...installer,
			narrowed: () => true,
		});
		expect(found.defaults.installOff).toBe(false);
	});

	test("save writes a local-only config, then refuses to overwrite it", async () => {
		const home = join(ROOT, "home-save");
		const deps = await setupDeps(home, NOWHERE, installer);
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

	test("the project is the one the working directory is in, and absent outside one", async () => {
		const repo = gitRepo("widget");
		const inside = await setupDeps(join(ROOT, "home-project"), repo, installer);
		expect(inside.defaults.project).toBe("widget");
		const outside = await setupDeps(
			join(ROOT, "home-project"),
			NOWHERE,
			installer,
		);
		expect(outside.defaults.project).toBeUndefined();
	});

	test("fileFirstIssue files a next issue for the agent, in the project, naming its instruction file", async () => {
		const home = join(ROOT, "home-first-issue");
		const repo = gitRepo("gadget");
		const deps = await setupDeps(home, repo, installer);
		await deps.save({
			actor: "cabane://actor/human/ada",
			deviceId: "mbp",
			install: ["claude"],
		});
		const filed = await deps.fileFirstIssue("codex");
		expect(filed.ok && filed.value.title).toBe("Add kabane to AGENTS.md");
		const ctx = await openContext(home, repo, parseArgs([]));
		if (!ctx.ok || !filed.ok) throw new Error("setup did not land");
		const task = await Planner.getTask(ctx.value.store, filed.value.shortId);
		expect(task.ok && task.value).toMatchObject({
			kind: "issue",
			state: "next",
			assignee: "codex",
			description: firstIssueBrief("AGENTS.md"),
		});
	});

	test("fileFirstIssue outside a project files nothing and says why", async () => {
		const home = join(ROOT, "home-no-project");
		const deps = await setupDeps(home, NOWHERE, installer);
		await deps.save({
			actor: "cabane://actor/human/ada",
			deviceId: "mbp",
			install: ["claude"],
		});
		const filed = await deps.fileFirstIssue("claude");
		expect(filed.ok).toBe(false);
	});
});

describe("firstIssueBrief", () => {
	// The guide gives a human the same block to paste by hand; the two must not drift apart.
	test("carries the tracker block getting-started.md gives, word for word", () => {
		const guide = readFileSync(
			join(import.meta.dir, "../../../docs/getting-started.md"),
			"utf8",
		);
		const block = /```markdown\n(## Tracker[\s\S]*?)```/.exec(guide)?.[1];
		expect(block).toBeDefined();
		expect(firstIssueBrief("CLAUDE.md")).toContain(block ?? "");
		expect(firstIssueBrief("CLAUDE.md")).toContain(
			"`CLAUDE.md` at the project root",
		);
	});
});

describe("tildePath", () => {
	test("shortens a path under the home directory, and only that", () => {
		expect(tildePath("/Users/alex/.kabane/config.json", "/Users/alex")).toBe(
			"~/.kabane/config.json",
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
		expect(
			outcomeOf({
				harness: "codex",
				status: "failed",
				error:
					"WARNING: proceeding\nError: failed to load\nCaused by: no home\n",
			}).message,
		).toBe("Caused by: no home");
	});
});
