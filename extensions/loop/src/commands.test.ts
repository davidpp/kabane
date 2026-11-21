import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import "@kabane/core/testing";
import { join } from "node:path";
import { ok, Planner, trySync } from "@kabane/core";
import { GitFixture } from "@kabane/core/git-fixture";
import { Settings } from "@kabane/extension";
import { Loop } from "./commands";
import type { LoopConfig } from "./config";
import { Permission } from "./permission";
import { isAnswerTo } from "./question-body";
import { RunStore } from "./store";
import { TestHarnesses } from "./test-harnesses";
import { testHost, pinTestScope, testScope } from "./test-host";
import { TestSessions } from "./test-sessions";
import { Worktree } from "./worktree";

// `start`'s refusals, which all come before a runner is spawned, and `restart`, whose runner is
// the real `Loop.run` on a run that claims nothing. Starting a run that reaches a harness is the
// sandbox check, not a unit test.
let root = "";
let home = "";
let repo = "";

// The fixture's git, so the machine's hooks never run on a worktree a start adds.
const fixtureGit: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));

const deps = () => ({
	home,
	basePath: home,
	host: testHost(home, undefined, testScope(repo)),
	kabaneBin: () => "/nonexistent/kabane",
	cwd: repo,
	// Never reached: every case below is refused before the spawn.
	runner: () => ["/nonexistent/runner"],
	git: fixtureGit,
	// No stored layers: the caller's config over the defaults, through the real resolver.
	settings: Settings.port(async () => ok([])),
});

const CONFIG: LoopConfig.Config = {
	implementer: "claude",
	tiers: {},
	harnesses: {},
	budget: { concurrency: 1, continuations: 0, currency: "USD" },
	stallAfter: 1,
	gates: {},
	worktree: false,
	isolation: "worktree",
	reuse: true,
	lenses: [],
	recheck: true,
	review: { mode: "triage", tier: "fast" },
	land: "none",
};

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
	pinTestScope(repo);
	GitFixture.run(repo, ["add", ".kabane/scope"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const repoScope = async (): Promise<string> => {
	const scope = testScope(repo);
	if (!scope) throw new Error("the fixture repo has no scope");
	return scope.scopeUri;
};

describe("Loop command id resolution", () => {
	it("prepares a run from a lowercase short id", async () => {
		const issue = await add("ready", { scopeUri: await repoScope() });
		if (!issue.shortId) throw new Error("Missing short id");
		const prepared = await Loop.prepare(deps(), {
			parent: issue.shortId.toLowerCase(),
		});
		if (!prepared.ok) throw prepared.error;
		expect(prepared.value.plan.parent.id).toBe(issue.id);
	});

	it("reports absence and preserves ambiguous candidates at both command entries", async () => {
		const first = await add("First candidate");
		const second = await add("Second candidate");
		for (const id of ["JCAB-999999", "missing", "01AAAAAAAAAAAAAAAAAAAAAAAA"]) {
			for (const result of [
				await Loop.prepare(deps(), { parent: id }),
				await Loop.direct(deps(), "skip", id),
			]) {
				expect(!result.ok && result.error.message).toBe(`No task ${id}`);
			}
		}
		const prefix = first.id.slice(0, 1);
		const expected = await Planner.resolveTaskId(home, prefix);
		if (expected.ok) throw new Error("Expected ambiguous prefix");
		for (const result of [
			await Loop.prepare(deps(), { parent: prefix }),
			await Loop.direct(deps(), "skip", prefix),
		]) {
			expect(!result.ok && result.error.message).toBe(expected.error.message);
			if (!result.ok) {
				for (const candidate of [first, second]) {
					expect(result.error.message).toContain(
						`${candidate.shortId}  ${candidate.title}`,
					);
				}
			}
		}
	});
});

describe("Loop.start refusals", () => {
	it("refuses a human task with no subtasks: nothing in it is a loop's to run", async () => {
		const task = await add("errand", {
			kind: "task",
			scopeUri: await repoScope(),
		});
		const started = await Loop.start(deps(), { parent: task.id });
		expect(!started.ok && started.error.message).toBe(
			`${task.shortId} is a task with no subtasks, so a loop has nothing to run: make it an issue, or give it issue subtasks`,
		);
	});

	it("starts an issue with no subtasks as a single issue, up to the runner", async () => {
		const issue = await add("lone", { scopeUri: await repoScope() });
		const started = await Loop.start(deps(), { parent: issue.id });
		// Past every refusal: the run is written on the issue and only the (nonexistent) runner fails.
		expect(!started.ok && started.error.message).toContain("runner");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value.map((r) => [r.parentId, r.status])).toEqual([
			[issue.id, "failed"],
		]);
	});

	it("refuses a single issue someone holds or parked, which a run could only wait on", async () => {
		const scopeUri = await repoScope();
		const held = await add("held", { scopeUri, state: "in_progress" });
		const later = await add("later", {
			scopeUri,
			deferUntil: "2999-01-01T00:00:00.000Z",
		});
		const heldStart = await Loop.start(deps(), { parent: held.id });
		expect(!heldStart.ok && heldStart.error.message).toBe(
			`${held.shortId} is in_progress, so a loop run could not claim it: move it to next to run it`,
		);
		const laterStart = await Loop.start(deps(), { parent: later.id });
		expect(!laterStart.ok && laterStart.error.message).toContain(
			`${later.shortId} is deferred until 2999-01-01`,
		);
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toEqual([]);
	});

	it("refuses a closed single issue with nothing to check, in its own words", async () => {
		const issue = await add("shipped", {
			scopeUri: await repoScope(),
			state: "done",
		});
		const started = await Loop.start(deps(), {
			parent: issue.id,
			config: { gates: {} },
		});
		expect(!started.ok && started.error.message).toBe(
			`${issue.shortId} is already done, no finding under it is open, and no gates or lenses are configured to check it`,
		);
	});

	it("refuses a single issue that already has a live run", async () => {
		const issue = await add("lone", { scopeUri: await repoScope() });
		RunStore.create(home, {
			version: 1,
			id: "live-run",
			parentId: issue.id,
			parentShortId: issue.shortId ?? issue.id,
			projectDir: repo,
			config: CONFIG,
			status: "running",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: { paused: false, skipped: [], next: [] },
			gateRuns: [],
		});
		const started = await Loop.start(deps(), { parent: issue.id });
		expect(!started.ok && started.error.message).toBe(
			`${issue.shortId} already has a live loop run: live-run`,
		);
	});

	it("refuses a directory that is not the parent's scope, and names --dir", async () => {
		const parent = await add("parent", {
			scopeUri: "kabane://scope/elsewhere",
		});
		await add("child", {
			parentTaskId: parent.id,
			scopeUri: "kabane://scope/elsewhere",
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) {
			expect(started.error.message).toContain("kabane://scope/elsewhere");
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
			config: CONFIG,
			status: "running",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: { paused: false, skipped: [], next: [] },
			gateRuns: [],
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("live-run");
	});
});

describe("Loop.start with a worktree", () => {
	it("a worktree run started in a folder of the repository works in that folder of the worktree", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		const folder = join(repo, "packages", "foo");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "package.json"), "{}\n");
		GitFixture.run(repo, ["add", "-A"]);
		GitFixture.run(repo, ["commit", "-q", "-m", "foo"]);
		const git: Worktree.Git = async (cwd, args) =>
			trySync(() => GitFixture.run(cwd, args));

		// Past the worktree: the run is written and only the (nonexistent) runner fails.
		await Loop.start(
			{ ...deps(), cwd: folder, git },
			{ parent: parent.id, config: { worktree: true } },
		);
		const runs = RunStore.list(home);
		const run = runs.ok ? runs.value[0] : undefined;
		if (!run?.worktree) throw new Error("no worktree run was written");
		expect(RunStore.sessionDir(run)).toBe(
			join(run.worktree, "packages", "foo"),
		);
		expect(existsSync(join(RunStore.sessionDir(run), "package.json"))).toBe(
			true,
		);
	});
});

describe("Loop.start from a folder of the project", () => {
	it("works in that folder, and reads the project's lenses at its root, where its settings are", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		const lenses = join(
			repo,
			".claude",
			"skills",
			"dispatch",
			"references",
			"lenses",
		);
		mkdirSync(lenses, { recursive: true });
		writeFileSync(join(lenses, "security.md"), "Review the security.\n");
		const folder = join(repo, "src");
		mkdirSync(folder);

		const prepared = await Loop.prepare(
			{ ...deps(), cwd: folder },
			{ parent: parent.id, config: { lenses: ["security"] } },
		);
		if (!prepared.ok) throw prepared.error;
		expect(prepared.value.projectDir).toBe(folder);
		expect(prepared.value.projectRoot).toBe(repo);

		// Past the lens check: the run is written and only the (nonexistent) runner fails.
		await Loop.start(
			{ ...deps(), cwd: folder },
			{ parent: parent.id, config: { lenses: ["security"] } },
		);
		const runs = RunStore.list(home);
		const run = runs.ok ? runs.value[0] : undefined;
		expect(run && [run.projectDir, RunStore.projectRoot(run)]).toEqual([
			folder,
			repo,
		]);
	});
});

describe("Loop.start with a worktree, from a folder HEAD lacks", () => {
	it("refuses before adding a worktree or a branch", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		const folder = join(repo, "packages", "new");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "draft.ts"), "\n");
		const git: Worktree.Git = async (cwd, args) =>
			trySync(() => GitFixture.run(cwd, args));

		const started = await Loop.start(
			{ ...deps(), cwd: folder, git },
			{ parent: parent.id, config: { worktree: true } },
		);
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("not committed");
		const branches = GitFixture.run(repo, ["branch", "--list"]);
		expect(branches.trim()).toBe("* main");
		const worktrees = GitFixture.run(repo, ["worktree", "list"]);
		expect(worktrees.trim().split("\n")).toHaveLength(1);
	});
});

describe("Loop.start's worktree", () => {
	let tick = 0;
	// Each start a millisecond apart, so run ids and their newest-first order are distinct.
	const startOn = async (
		parentId: string,
		config: LoopConfig.Overrides = {},
		cwd = repo,
	): Promise<RunStore.Run> => {
		tick += 1;
		const at = new Date(Date.UTC(2026, 10, 4, 12, 0, 0, tick));
		// Past the worktree: the run is written and only the (nonexistent) runner fails.
		await Loop.start(
			{ ...deps(), cwd, now: () => at },
			{ parent: parentId, config },
		);
		const runs = RunStore.list(home);
		const run = runs.ok ? runs.value[0] : undefined;
		if (!run) throw new Error("no run was written");
		expect(run.exit?.reason).not.toBe("worktree-not-created");
		return run;
	};

	const parentWithChild = async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		return parent;
	};

	// What a session leaves in the run's worktree: a checkpoint on its branch.
	const commitIn = (dir: string, file: string) => {
		writeFileSync(join(dir, file), `${file}\n`);
		GitFixture.run(dir, ["add", "-A"]);
		GitFixture.run(dir, ["commit", "-q", "-m", file]);
	};

	const placementEvent = (run: RunStore.Run) => {
		const events = RunStore.readEvents(home, run.id);
		return events.ok
			? events.value.find((e) => e.type === "workspace")
			: undefined;
	};

	const worktreeCount = () =>
		GitFixture.run(repo, ["worktree", "list"]).trim().split("\n").length;

	it("is on by default: a new worktree of HEAD on the run's own branch", async () => {
		const parent = await parentWithChild();
		const run = await startOn(parent.id);
		expect(run.config.worktree).toBe(true);
		expect(run.worktree).toBe(
			Worktree.dirFor(RunStore.paths(home, run.id).dir),
		);
		expect(run.worktreeReused).toBeUndefined();
		expect(
			GitFixture.run(run.worktree ?? "", ["branch", "--show-current"]).trim(),
		).toBe(`${parent.shortId?.toLowerCase()}-parent`);
		expect(run.branch).toBe(`${parent.shortId?.toLowerCase()}-parent`);
		expect(placementEvent(run)?.summary).toContain(
			`new, on branch ${run.branch} from main`,
		);
	});

	it("records the branch and commit it was made from, and a run going on in it keeps them", async () => {
		const parent = await parentWithChild();
		const sha = GitFixture.run(repo, ["rev-parse", "HEAD"]).trim();
		const first = await startOn(parent.id);
		expect(first.base).toEqual({ branch: "main", sha });
		commitIn(first.worktree ?? "", "first.txt");
		// The project moves on meanwhile; the work in the worktree still started from `sha`.
		GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "later"]);
		const second = await startOn(parent.id);
		expect(second.worktreeReused?.runId).toBe(first.id);
		expect(second.base).toEqual({ branch: "main", sha });
	});

	it("records no base branch for a project on a detached HEAD", async () => {
		const parent = await parentWithChild();
		GitFixture.run(repo, ["checkout", "-q", "--detach"]);
		const run = await startOn(parent.id);
		expect(run.base).toEqual({
			sha: GitFixture.run(repo, ["rev-parse", "HEAD"]).trim(),
		});
	});

	it("turned off, works in the checkout itself", async () => {
		const parent = await parentWithChild();
		const run = await startOn(parent.id, { worktree: false });
		expect(run.worktree).toBeUndefined();
		expect(RunStore.sessionDir(run)).toBe(repo);
		expect(worktreeCount()).toBe(1);
		expect(placementEvent(run)).toBeUndefined();
	});

	it("works in place in a directory that is not a git repository, and says so", async () => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id });
		const run = await startOn(parent.id, {}, plain);
		expect(run.config.worktree).toBe(true);
		expect(run.worktree).toBeUndefined();
		expect(RunStore.sessionDir(run)).toBe(plain);
		expect(Loop.placement(run)).toContain("not a git repository");
		expect(placementEvent(run)?.summary).toBe(Loop.placement(run));
	});

	it("goes on in the parent's last worktree while its branch is not merged into HEAD", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		commitIn(first.worktree ?? "", "first.txt");
		const second = await startOn(parent.id);
		expect(second.worktree).toBe(first.worktree);
		expect(second.worktreeReused).toEqual({
			runId: first.id,
			branch: first.branch ?? "",
		});
		expect(placementEvent(second)?.data).toMatchObject({
			reusedFrom: first.id,
			branch: first.branch ?? "",
		});
		// A third run takes over the same worktree from the second.
		const third = await startOn(parent.id);
		expect(third.worktree).toBe(first.worktree);
		expect(third.worktreeReused?.runId).toBe(second.id);
		expect(worktreeCount()).toBe(2);
	});

	it("makes a new worktree once the last one's branch is merged", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		commitIn(first.worktree ?? "", "first.txt");
		GitFixture.run(repo, ["merge", "-q", first.branch ?? ""]);
		const second = await startOn(parent.id);
		expect(second.worktreeReused).toBeUndefined();
		expect(second.worktree).toBe(
			Worktree.dirFor(RunStore.paths(home, second.id).dir),
		);
		expect(existsSync(join(second.worktree ?? "", "first.txt"))).toBe(true);
	});

	it("makes a new worktree when the last one was removed", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		commitIn(first.worktree ?? "", "first.txt");
		GitFixture.run(repo, ["worktree", "remove", first.worktree ?? ""]);
		const second = await startOn(parent.id);
		expect(second.worktreeReused).toBeUndefined();
		expect(second.worktree).not.toBe(first.worktree);
	});

	it("never takes over a worktree a live run is working in", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		commitIn(first.worktree ?? "", "first.txt");
		const other = await add("other parent");
		RunStore.create(home, {
			...first,
			id: "live-elsewhere",
			parentId: other.id,
			status: "running",
			pid: process.pid,
			exit: undefined,
			createdAt: new Date(0).toISOString(),
		});
		const second = await startOn(parent.id);
		expect(second.worktreeReused).toBeUndefined();
		expect(second.worktree).not.toBe(first.worktree);
	});
});

// The runner `restart` spawns: the real `Loop.run` on this test's tracker, as `kabane loop run`
// runs it, with no harness a claim could reach.
const RUNNER = [
	`import { testHost } from ${JSON.stringify(join(import.meta.dir, "test-host.ts"))};`,
	`import ${JSON.stringify(Bun.resolveSync("@kabane/core/testing", import.meta.dir))};`,
	`import { Loop } from ${JSON.stringify(join(import.meta.dir, "commands.ts"))};`,
	`const home = process.env.KABANE_HOME ?? "";`,
	`const ran = await Loop.run({ home, basePath: home, host: testHost(home), kabaneBin: () => "/nonexistent/kabane", overrides: ${JSON.stringify(TestHarnesses.NOWHERE)} }, process.argv[1] ?? "");`,
	`process.exit(ran.ok ? 0 : 1);`,
].join("\n");

// A pid that existed and is gone: the exited child of a real spawn.
const deadPid = (): number => Bun.spawnSync(["true"]).pid;

// A paused run whose runner died while its claim on `child` was open: restarted, it claims
// nothing, so no harness is reached.
const orphaned = async (id: string) => {
	const parent = await add("parent");
	const child = await add("child", {
		parentTaskId: parent.id,
		state: "in_progress",
		assignee: "claude",
	});
	const sessionId = RunStore.newSessionId();
	const created = RunStore.create(home, {
		version: 1,
		id,
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: repo,
		config: CONFIG,
		status: "running",
		pid: deadPid(),
		createdAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		claims: [
			{
				taskId: child.id,
				shortId: child.shortId ?? child.id,
				harness: "claude",
				lane: "claude:child",
				sessionId: sessionId,
				startedAt: new Date().toISOString(),
				continuations: 0,
			},
		],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: { paused: true, skipped: [], next: [] },
		gateRuns: [],
	});
	if (!created.ok) throw created.error;
	return { run: created.value, parent, child, sessionId: sessionId };
};

describe("Loop.start on a parent whose last run lost its runner", () => {
	it("refuses, naming the run and the command that restarts it, and writes no run", async () => {
		const { run, child } = await orphaned("dead-run");
		const started = await Loop.start(deps(), { parent: run.parentId });
		expect(!started.ok && started.error.message).toContain(
			`kabane loop resume ${run.id}`,
		);
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value.map((r) => r.id)).toEqual([run.id]);
		const held = await Planner.getTask(home, child.id);
		expect(held.ok && held.value?.state).toBe("in_progress");
	});

	it("starts once the run that died is over", async () => {
		const { run } = await orphaned("dead-run");
		RunStore.write(home, {
			...run,
			status: "stopped",
			exit: { reason: "stop-requested" },
		});
		const started = await Loop.start(deps(), { parent: run.parentId });
		// Past the checks: the run is written and only the (nonexistent) runner fails.
		expect(!started.ok && started.error.message).not.toContain(run.id);
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toHaveLength(2);
	});
});

describe("Loop.restart", () => {
	it("brings a run whose runner died back in a detached runner, which releases the claim it left open", async () => {
		const { run, child } = await orphaned("dead-run");
		const restarted = await Loop.restart(
			{ ...deps(), runner: (id) => [process.execPath, "-e", RUNNER, id] },
			run.id,
		);
		const pid = restarted.ok ? restarted.value.pid : undefined;
		try {
			expect(restarted.ok && restarted.value.status).toBe("running");
			expect(pid).not.toBe(run.pid);
			// Once the runner has wound down, everything it did on the way is on record.
			const stopped = await Loop.stop({ home, waitMs: 15_000 }, run.id);
			expect(stopped.ok && stopped.value.status).toBe("stopped");
			const events = RunStore.readEvents(home, run.id);
			expect(events.ok && events.value.map((e) => e.type)).toContain(
				"run_resume",
			);
			expect(stopped.ok && stopped.value.claims[0]?.outcome).toBe(
				"interrupted",
			);
			const released = await Planner.getTask(home, child.id);
			expect(released.ok && released.value?.state).toBe("next");
		} finally {
			if (pid !== undefined && RunStore.runnerAlive(pid)) process.kill(pid);
		}
	}, 30_000);

	it("spawns no runner once the kabane that would run it is gone, and says to restart the board", async () => {
		const { run } = await orphaned("dead-run");
		const { runner: _, ...rest } = deps();
		const restarted = await Loop.restart(
			{ ...rest, kabaneBin: () => null },
			run.id,
		);
		expect(!restarted.ok && restarted.error.message).toBe(
			"kabane was updated or moved since the board started: restart the board",
		);
		const after = RunStore.read(home, run.id);
		expect(after.ok && Loop.died(after.value)).toBe(true);
	});

	it("refuses a run whose runner is not dead, and one whose parent has another live run", async () => {
		const { run } = await orphaned("dead-run");
		const live = RunStore.create(home, {
			...run,
			id: "live-run",
			pid: process.pid,
			claims: [],
		});
		if (!live.ok) throw live.error;
		const alive = await Loop.restart(deps(), "live-run");
		expect(!alive.ok && alive.error.message).toContain(
			"only a run whose runner died",
		);
		const rival = await Loop.restart(deps(), run.id);
		expect(!rival.ok && rival.error.message).toContain("live-run");
	});
});

describe("Loop.answer", () => {
	const HUMAN = "kabane://actor/human/david";

	// A loop session of run `runId` blocked on a relayed permission request.
	const blocked = async (runId: string) => {
		mkdirSync(RunStore.paths(home, runId).dir, { recursive: true });
		const task = await add("child");
		const session = await TestSessions.open(home, {
			taskId: task.id,
			agent: "claude",
			externalRef: `loop:${runId}`,
		});
		if (!session.ok) throw session.error;
		const question = await TestSessions.append(home, {
			sessionId: session.value.id,
			type: "question",
			body: Permission.body("claude", {
				toolCallId: "toolu_01",
				title: "Write notes.md",
				options: [
					{ id: "allow", name: "Allow", kind: "allow_once" },
					{ id: "reject", name: "Reject", kind: "reject_once" },
				],
			}),
		});
		if (!question.ok) throw question.error;
		return { sessionId: session.value.id, questionId: question.value.id };
	};

	it("submits the chosen option to the inbox without writing the runner's journal", async () => {
		const { sessionId, questionId } = await blocked("run-1");
		const listed = await Loop.questions({ home }, "run-1");
		expect(listed.ok && listed.value.map((q) => q.questionId)).toEqual([
			questionId,
		]);
		const before = await TestSessions.journal(home, sessionId);
		const answered = await Loop.answer(
			{ home, basePath: home, host: testHost(home), actor: HUMAN },
			questionId,
			"2",
		);
		expect(answered.ok && answered.value.answer).toBe("Reject");
		expect(await TestSessions.journal(home, sessionId)).toEqual(before);
		const inbox = RunStore.readInbox(home, "run-1", 0);
		expect(inbox.ok && inbox.value.entries).toMatchObject([
			{ kind: "answered", questionId, answer: "Reject", by: HUMAN },
		]);
		expect(await Loop.questions({ home }, "run-1")).toEqual({
			ok: true,
			value: [],
		});
		expect(
			(
				await Loop.answer(
					{ home, basePath: home, host: testHost(home), actor: HUMAN },
					questionId,
					"1",
				)
			).ok,
		).toBe(false);
	});

	it("refuses a dead runner's questions and reports them without changing its journal", async () => {
		const { run, sessionId } = await orphaned("dead-run");
		const asked = TestSessions.append(home, {
			sessionId,
			type: "question",
			body: "Which store?",
		});
		if (!asked.ok) throw asked.error;
		const before = TestSessions.journal(home, sessionId);
		const answered = await Loop.answer(
			{ home, basePath: home, host: testHost(home), actor: HUMAN },
			asked.value.id,
			"SQLite",
		);
		expect(!answered.ok && answered.error.message).toContain("runner died");
		expect(!answered.ok && answered.error.message).toContain(
			`kabane loop resume ${run.id}`,
		);
		const stranded = await Loop.withdraw({ home }, RunStore.effective(run));
		expect(stranded.ok && stranded.value.map((q) => q.questionId)).toEqual([
			asked.value.id,
		]);
		expect(TestSessions.journal(home, sessionId)).toEqual(before);
		expect(await Loop.questions({ home }, run.id)).toEqual({
			ok: true,
			value: [],
		});
	});

	it("reports only unanswered questions from a dead run", async () => {
		const { run, sessionId } = await orphaned("dead-run");
		const asked = ["answered", "withdrawn", "open"].map((body) =>
			TestSessions.append(home, { sessionId, type: "question", body }),
		);
		const [answered, withdrawn, open] = asked;
		if (!answered?.ok || !withdrawn?.ok || !open?.ok)
			throw new Error("question setup failed");
		expect(
			TestSessions.append(home, {
				sessionId,
				type: "decision",
				body: "SQLite",
				context: `answers ${answered.value.id}`,
			}).ok,
		).toBe(true);
		expect(
			TestSessions.append(home, {
				sessionId,
				type: "withdrawn",
				body: "harness withdrew",
				context: `answers ${withdrawn.value.id}`,
			}).ok,
		).toBe(true);
		const stranded = await Loop.withdraw({ home }, RunStore.effective(run));
		expect(stranded.ok && stranded.value.map((q) => q.questionId)).toEqual([
			open.value.id,
		]);
	});

	it("refuses an answer that is none of the harness's options, and answers nothing", async () => {
		const { sessionId, questionId } = await blocked("run-1");
		const answered = await Loop.answer(
			{ home, basePath: home, host: testHost(home), actor: HUMAN },
			questionId,
			"yes please",
		);
		expect(answered.ok).toBe(false);
		const activities = await TestSessions.journal(home, sessionId);
		expect(
			activities.ok &&
				activities.value.some((a) => isAnswerTo(a.context, questionId)),
		).toBe(false);
	});
});

describe("Loop.stop", () => {
	it("returns a run whose pid now belongs to another process as over, without waiting", async () => {
		// This process stands in for a later one handed the dead runner's pid.
		RunStore.create(home, {
			version: 1,
			id: "recycled-run",
			parentId: "01PARENT",
			parentShortId: "KAB-1",
			projectDir: repo,
			config: {
				implementer: "claude",
				tiers: {},
				harnesses: {},
				budget: { concurrency: 1, continuations: 0, currency: "USD" },
				stallAfter: 1,
				gates: {},
				worktree: false,
				isolation: "worktree",
				reuse: true,
				lenses: [],
				recheck: true,
				review: { mode: "all", tier: "fast" },
				land: "none",
			},
			status: "running",
			pid: process.pid,
			pidStart: "the dead runner's start",
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: { paused: false, skipped: [], next: [] },
			gateRuns: [],
		});
		const stopped = await Loop.stop({ home, waitMs: 60_000 }, "recycled-run");
		expect(stopped.ok && stopped.value.exit?.reason).toBe("runner-died");
	});
});

describe("Loop.advise", () => {
	it("routes only the open subtasks, and says when a named agent is nowhere to be found", async () => {
		const parent = await add("parent");
		await add("shipped", { parentTaskId: parent.id, state: "done" });
		const open = await add("open", {
			parentTaskId: parent.id,
			tags: ["agent:no-such-agent-jcab-247"],
		});
		const advised = await Loop.advise(deps(), { parent: parent.id });
		if (!advised.ok) throw advised.error;
		expect(advised.value.subtasks).toEqual([
			{
				task: open.shortId ?? open.id,
				title: "open",
				tags: ["agent:no-such-agent-jcab-247"],
				harness: "claude",
				modelSource: "default",
				notes: [
					"no no-such-agent-jcab-247 agent is defined for claude in the project or your home, so it runs its default agent",
				],
			},
		]);
		expect(RunStore.list(home)).toEqual(ok([]));
	});
});

describe("Loop.advise, a project agent and the run's worktree", () => {
	it("says a worktree run won't see an agent HEAD lacks, and routes to it once committed", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("docs", {
			parentTaskId: parent.id,
			scopeUri,
			tags: ["agent:docs-writer"],
		});
		mkdirSync(join(repo, ".claude/agents"), { recursive: true });
		writeFileSync(
			join(repo, ".claude/agents/docs-writer.md"),
			"---\nname: docs-writer\nmodel: haiku\n---\nWrite docs.\n",
		);
		const routed = async (worktree: boolean) => {
			const advised = await Loop.advise(deps(), {
				parent: parent.id,
				config: { worktree },
			});
			if (!advised.ok) throw advised.error;
			const [docs] = advised.value.subtasks;
			return [docs?.agent, docs?.model, docs?.notes];
		};
		expect(await routed(true)).toEqual([
			undefined,
			undefined,
			[
				"agent docs-writer is not committed; a worktree run won't see it, so it runs its default agent",
			],
		]);
		// Without a worktree the session runs in this checkout, where the file is.
		expect(await routed(false)).toEqual(["docs-writer", "haiku", []]);
		GitFixture.run(repo, ["add", ".claude"]);
		GitFixture.run(repo, ["commit", "-q", "-m", "agent"]);
		expect(await routed(true)).toEqual(["docs-writer", "haiku", []]);
	});
});
