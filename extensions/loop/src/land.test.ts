// Landing a run's branch with real git: the project's remote is a bare repository on disk, so
// fetch, rebase and push are git's own, and a teammate's clone of it moves the base meanwhile.
// Only git's config is the fixture's (an identity, no signing), as in every test.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { LoopConfig } from "./config";
import { Land } from "./land";
import type { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let remote = "";
let repo = "";
let teammate = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));
const head = (dir: string): string =>
	GitFixture.run(dir, ["rev-parse", "HEAD"]).trim();

const commit = (dir: string, file: string, text = `${file}\n`): void => {
	writeFileSync(join(dir, file), text);
	GitFixture.run(dir, ["add", "-A"]);
	GitFixture.run(dir, ["commit", "-q", "-m", file]);
};

// A teammate's commit on the remote's main, which the project's checkout has not fetched.
const baseMoves = (file: string, text?: string): void => {
	GitFixture.run(teammate, ["pull", "-q", "--ff-only"]);
	commit(teammate, file, text);
	GitFixture.run(teammate, ["push", "-q", "origin", "main"]);
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-land-"));
	home = join(root, "home");
	remote = join(root, "remote.git");
	repo = join(root, "repo");
	teammate = join(root, "teammate");
	mkdirSync(home);
	GitFixture.run(root, ["init", "-q", "--bare", remote]);
	GitFixture.run(root, ["clone", "-q", remote, repo]);
	commit(repo, "README.md", "# fixture\n");
	GitFixture.run(repo, ["push", "-q", "-u", "origin", "main"]);
	GitFixture.run(root, ["clone", "-q", remote, teammate]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const parentIssue = async (): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title: "Make the thing",
		kind: "issue",
		state: "in_progress",
		description: "The brief.",
	});
	if (!created.ok) throw created.error;
	return created.value;
};

// A completed run on `parent` as `Loop.start` writes it, with the work a session committed in
// its worktree.
const completedRun = async (
	parent: Task,
	config: LoopConfig.Input = {},
): Promise<RunStore.Run> => {
	const parsed = LoopConfig.Schema.safeParse({ land: "pr", ...config });
	if (!parsed.success) throw parsed.error;
	const id = "run-1";
	const dir = Worktree.dirFor(RunStore.paths(home, id).dir);
	const run: RunStore.Run = {
		version: 1,
		id,
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: repo,
		worktree: dir,
		worktreePrefix: "",
		base: { branch: "main", sha: head(repo) },
		config: parsed.data,
		status: "running",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	const added = await Worktree.add(repo, dir, "jcab-1-make-the-thing", git);
	if (!added.ok) throw added.error;
	commit(dir, "work.txt");
	return run;
};

const ctxFor = (run: RunStore.Run): RunState.Ctx => {
	const log = RunStore.eventLog(home, run.id);
	if (!log.ok) throw log.error;
	return {
		deps: {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
		},
		now: () => new Date(),
		tree: async (cwd) => head(cwd),
		log: log.value,
		run,
		live: new Map(),
		settled: [],
		wake: () => {},
		stopRequested: false,
		stopping: new AbortController(),
		gating: Promise.resolve(),
	};
};

describe("Land.land onto the base", () => {
	it("leaves a branch already on the base's latest commit as it is, and runs no gate", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, { gates: { test: "exit 1" } }),
		);
		const tip = head(ctx.run.worktree ?? "");

		const landing = await Land.land(ctx, parent);

		expect(landing.ok).toBe(true);
		expect(landing.summary).toContain("The branch is on origin/main");
		expect(landing.rebased).toBeUndefined();
		expect(head(ctx.run.worktree ?? "")).toBe(tip);
		expect(ctx.run.gateRuns).toEqual([]);
		const saved = RunStore.read(home, ctx.run.id);
		expect(saved.ok && saved.value.landing).toEqual(landing);
	});

	it("rebases onto a base that moved during the run and gates the rebased branch", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, {
				gates: { both: "test -f work.txt && test -f teammate.txt" },
			}),
		);
		const dir = ctx.run.worktree ?? "";
		const before = head(dir);
		const checkout = head(repo);
		baseMoves("teammate.txt");

		const landing = await Land.land(ctx, parent);

		expect(landing.ok).toBe(true);
		expect(landing.summary).toContain("Rebased onto origin/main");
		expect(landing.rebased).toEqual({ from: before, to: head(dir) });
		expect(existsSync(join(dir, "teammate.txt"))).toBe(true);
		// The gate ran on the rebased branch, and passed.
		expect(ctx.run.gateRuns.map((g) => [g.ok, g.tree])).toEqual([
			[true, head(dir)],
		]);
		// The user's own checkout is not touched.
		expect(head(repo)).toBe(checkout);
	});

	it("does not land a rebase that conflicts, and leaves the branch as the run left it", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		const dir = ctx.run.worktree ?? "";
		commit(dir, "README.md", "# ours\n");
		const before = head(dir);
		baseMoves("README.md", "# theirs\n");

		const landing = await Land.land(ctx, parent);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain("conflicts in README.md");
		expect(head(dir)).toBe(before);
		expect(GitFixture.run(dir, ["status", "--porcelain"]).trim()).toBe("");
		const events = RunStore.readEvents(home, ctx.run.id);
		expect(
			events.ok && events.value.map((e) => [e.type, e.summary]).at(-1),
		).toEqual(["warning", landing.summary]);
	});

	it("does not land a rebased branch whose gates are red, and puts the branch back", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, {
				gates: { alone: "test ! -f teammate.txt" },
			}),
		);
		const dir = ctx.run.worktree ?? "";
		const before = head(dir);
		baseMoves("teammate.txt");

		const landing = await Land.land(ctx, parent);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain("the gate alone failed (exit 1)");
		expect(landing.summary).toContain(`back at ${before.slice(0, 12)}`);
		expect(landing.rebased?.from).toBe(before);
		expect(head(dir)).toBe(before);
	});

	it("does not land a run that started from a detached HEAD", async () => {
		const parent = await parentIssue();
		const run = await completedRun(parent);
		const ctx = ctxFor({ ...run, base: { sha: run.base?.sha ?? "" } });

		const landing = await Land.land(ctx, parent);

		expect(landing).toMatchObject({ ok: false });
		expect(landing.summary).toContain("detached HEAD");
	});
});
