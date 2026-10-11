import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Brief } from "./brief";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let root = "";
let home = "";
let repo = "";

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-lenses-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const add = async (
	title: string,
	extra: Record<string, unknown> = {},
): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const claim = (
	lens: string,
	extra: Partial<RunStore.Claim> = {},
): RunStore.Claim => ({
	taskId: "parent",
	shortId: "K-1",
	harness: "claude",
	lane: `claude:${lens}-lens`,
	sessionId: `s-${lens}`,
	startedAt: "2026-10-11T00:00:00.000Z",
	continuations: 0,
	lens,
	...extra,
});

describe("Lenses.prompt", () => {
	it("ships functional and quality, and a repository's own file takes over a name", () => {
		const shipped = Lenses.prompt(repo, "functional");
		expect(shipped.ok && shipped.value).toStartWith("# Functional lens");
		mkdirSync(Lenses.dir(repo), { recursive: true });
		writeFileSync(join(Lenses.dir(repo), "functional.md"), "# Ours\n");
		writeFileSync(join(Lenses.dir(repo), "security.md"), "# Security\n");
		expect(Lenses.prompt(repo, "functional")).toEqual({
			ok: true,
			value: "# Ours\n",
		});
		expect(Lenses.prompt(repo, "security")).toEqual({
			ok: true,
			value: "# Security\n",
		});
		const unknown = Lenses.prompt(repo, "perf");
		expect(!unknown.ok && unknown.error.message).toContain(
			join(Lenses.dir(repo), "perf.md"),
		);
	});
});

describe("Lenses.status", () => {
	it("reads each lens's latest claim; an interrupted one runs again", () => {
		const status = Lenses.status(
			["functional", "quality", "security", "perf"],
			[
				claim("functional", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "done",
				}),
				claim("quality"),
				claim("security", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "interrupted",
				}),
			],
		);
		expect(status).toEqual({
			pending: ["security", "perf"],
			running: ["quality"],
			done: ["functional"],
			failed: [],
		});
		expect(Lenses.finished(status)).toBe(false);
		const failed = Lenses.status(
			["functional"],
			[
				claim("functional", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "error",
					detail: "claude is not on PATH",
				}),
			],
		);
		expect(failed.failed).toEqual([
			{ name: "functional", detail: "error: claude is not on PATH" },
		]);
		expect(Lenses.finished(Lenses.status([], []))).toBe(true);
	});
});

describe("Brief.lens", () => {
	it("tells the lens to file findings as tagged children of the parent, then gives the lens", async () => {
		const parent = await add("Ship the cache");
		const brief = Brief.lens(
			{
				runId: "run-1",
				parent,
				lens: "quality",
				prompt: "# Quality lens\n",
			},
			"the parent's own brief",
		);
		expect(brief).toContain("kabane_add");
		expect(brief).toContain(`parentTaskId "${parent.shortId}"`);
		expect(brief).toContain('tags ["finding", "<severity>", "quality"]');
		expect(brief).toContain("Do not change files");
		expect(brief.indexOf("# Quality lens")).toBeLessThan(
			brief.indexOf("the parent's own brief"),
		);
	});
});

describe("LoopPlan.findings", () => {
	it("counts what the lenses filed and the p1s still open", async () => {
		const parent = await add("parent");
		await add("done work", { parentTaskId: parent.id, state: "done" });
		await add("broken", {
			parentTaskId: parent.id,
			tags: ["finding", "p1", "functional"],
		});
		await add("nit", {
			parentTaskId: parent.id,
			tags: ["finding", "p3", "quality"],
		});
		const plan = await LoopPlan.load(home, parent.id);
		expect(plan.ok && LoopPlan.findings(plan.value)).toEqual({
			total: 2,
			openP1: 1,
		});
	});
});

describe("Runner lenses", () => {
	// The real runner on a plan whose work is done and whose gates pass: it runs the gates, then
	// starts the lens as a session on the parent. The launch points at no harness, so the lens
	// fails without reaching one, and the run stops saying so rather than completing unreviewed.
	it("reviews only after the gates, on the parent, and a lens that fails stops the run", async () => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id, state: "done" });
		const config = LoopConfig.Schema.safeParse({
			gates: { ok: "true" },
			lenses: ["functional"],
			budget: { wallMinutes: 5 },
		});
		if (!config.success) throw config.error;
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo,
			config: config.data,
			status: "pending",
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
		if (!created.ok) throw created.error;
		const ended = await Runner.run("run-1", {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			overrides: { claude: { command: "/nonexistent/harness" } },
			tickMs: 5,
		});
		if (!ended.ok) throw ended.error;

		expect([ended.value.status, ended.value.exit?.reason]).toEqual([
			"stopped",
			"lens-failed",
		]);
		expect(
			ended.value.claims.map((c) => [c.lens, c.lane, c.taskId, c.outcome]),
		).toEqual([["functional", "claude:functional-lens", parent.id, "error"]]);
		const events = RunStore.readEvents(home, "run-1");
		const types = events.ok ? events.value.map((e) => e.type) : [];
		expect(types.indexOf("gate_passed")).toBeLessThan(types.indexOf("claim"));
		const after = await Planner.getTask(home, parent.id);
		expect(after.ok && after.value?.state).toBe("next");
	});

	it("start refuses a lens with no prompt before anything runs", async () => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id });
		const started = await Loop.start(
			{
				home,
				basePath: home,
				kabaneBin: "/nonexistent/kabane",
				cwd: repo,
				runner: () => ["/nonexistent/runner"],
			},
			{ parent: parent.id, dir: ".", config: { lenses: ["perf"] } },
		);
		expect(!started.ok && started.error.message).toContain("No lens perf");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toEqual([]);
	});
});
