import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { detectScope } from "@cabane/core/scope";
import { Loop } from "./commands";
import { RunStore } from "./store";

// `start`'s refusals, which all come before a runner is spawned. Starting a real runner is the
// sandbox check, not a unit test.
let root = "";
let home = "";
let repo = "";

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent/kabane",
	cwd: repo,
	// Never reached: every case below is refused before the spawn.
	runner: () => ["/nonexistent/runner"],
});

const add = async (title: string, extra: Record<string, unknown> = {}) => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-start-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const repoScope = async (): Promise<string> => {
	const scope = await detectScope(repo, { home, detectExtensions: false });
	if (!scope) throw new Error("the fixture repo has no scope");
	return scope.scopeUri;
};

describe("Loop.start refusals", () => {
	it("refuses a parent with no subtasks", async () => {
		const parent = await add("parent", { scopeUri: await repoScope() });
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("no subtasks");
	});

	it("refuses a directory that is not the parent's scope, and names --dir", async () => {
		const parent = await add("parent", { scopeUri: "jake://scope/elsewhere" });
		await add("child", {
			parentTaskId: parent.id,
			scopeUri: "jake://scope/elsewhere",
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) {
			expect(started.error.message).toContain("jake://scope/elsewhere");
			expect(started.error.message).toContain("--dir");
		}
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toEqual([]);
	});

	it("matches the scope by id, whatever extensions the parent's scope carries", async () => {
		const scopeUri = `${await repoScope()}?package=sandbox`;
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		const started = await Loop.start(deps(), { parent: parent.id });
		// Past the folder check: the run is written and only the (nonexistent) runner fails.
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).not.toContain("--dir");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value.map((r) => [r.status, r.projectDir])).toEqual([
			["failed", repo],
		]);
	});

	it("refuses a parent that already has a live run", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		RunStore.create(home, {
			version: 1,
			id: "live-run",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo,
			config: {
				implementer: "claude",
				budget: {
					concurrency: 1,
					wallMinutes: 1,
					continuations: 0,
					currency: "USD",
				},
				stallAfter: 1,
			},
			status: "running",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("live-run");
	});
});
