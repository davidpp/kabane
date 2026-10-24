// Gates, checkpoints and rollback against a real tracker and a real git repository with a real
// worktree. Only git's config is the fixture's (an identity, no signing), as in every test.
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
import { Brief } from "./brief";
import { Checks } from "./checks";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Gates } from "./gates";
import { Runner } from "./runner";
import type { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let repo = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));
const head = (dir: string): string =>
	GitFixture.run(dir, ["rev-parse", "HEAD"]).trim();

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-checks-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	GitFixture.run(repo, ["add", "-A"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "first"]);
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

// A run on `parent` as `Loop.start` writes it, with a worktree of the fixture repo when asked.
const runOn = async (
	parent: Task,
	gates: Record<string, string>,
	worktree: boolean,
): Promise<RunStore.Run> => {
	const config = LoopConfig.Schema.safeParse({
		gates,
		worktree,
		budget: { wallMinutes: 5 },
	});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
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
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	if (!worktree) return run;
	const dir = Worktree.dirFor(RunStore.paths(home, run.id).dir);
	const added = await Worktree.add(repo, dir, Worktree.branchFor(run.id), git);
	if (!added.ok) throw added.error;
	const written = RunStore.write(home, { ...run, worktree: dir });
	if (!written.ok) throw written.error;
	return written.value;
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
		tree: async () => "tree",
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

const refsOf = async (taskId: string) => {
	const logs = await Planner.getWorkLogs(home, taskId);
	if (!logs.ok) throw logs.error;
	return logs.value.flatMap((l) => l.refs.map((r) => r.uri));
};

describe("Checks", () => {
	it("a green pass in a worktree commits a checkpoint there, never in the checkout", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "done",
		});
		const ctx = ctxFor(await runOn(parent, { built: "test -f out.txt" }, true));
		const worktree = ctx.run.worktree ?? "";
		const before = head(repo);
		writeFileSync(join(worktree, "out.txt"), "made by the session\n");

		const subject = {
			taskId: child.id,
			label: child.shortId ?? "",
			title: "child",
		};
		const pass = await Checks.gate(ctx, subject);
		await Checks.record(ctx, pass, subject);

		expect(pass.ok).toBe(true);
		expect(pass.checkpoint).toBe(head(worktree));
		expect(head(repo)).toBe(before);
		expect(RunStore.checkpoints(ctx.run)).toEqual([head(worktree)]);
		expect(await refsOf(child.id)).toEqual([
			"gate:built",
			`commit:${head(worktree)}`,
		]);
		const task = await Planner.getTask(home, child.id);
		expect(task.ok && task.value?.state).toBe("done");
	});

	it("a red pass reopens the subtask, and its next brief quotes the gate's output", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "done",
		});
		const ctx = ctxFor(
			await runOn(
				parent,
				{ test: "echo 'expected 2, got 3' >&2; exit 3" },
				true,
			),
		);

		const subject = {
			taskId: child.id,
			label: child.shortId ?? "",
			title: "child",
		};
		const pass = await Checks.gate(ctx, subject);
		await Checks.record(ctx, pass, subject);

		expect(pass).toMatchObject({ ok: false });
		expect(pass.checkpoint).toBeUndefined();
		const task = await Planner.getTask(home, child.id);
		expect(task.ok && task.value?.state).toBe("next");
		const logs = await Planner.getWorkLogs(home, child.id);
		expect(logs.ok && logs.value[0]?.note).toBe("expected 2, got 3");

		const retry = Gates.lastFailure(ctx.run.gateRuns, child.id);
		const brief = Brief.opening(
			{ runId: "run-1", parent, task: child, ...(retry ? { retry } : {}) },
			"the issue's own brief",
		);
		expect(brief).toContain("reopened: the `test` gate");
		expect(brief).toContain("exit 3");
		expect(brief).toContain("expected 2, got 3");
	});

	for (const change of [
		{ state: "waiting" },
		{ state: "cancelled" },
		{ kind: "task" },
		{ assignee: "owner" },
	] as const) {
		it(`preserves ${JSON.stringify(change)} while a red gate runs`, async () => {
			const parent = await add("parent");
			const child = await add("child", {
				parentTaskId: parent.id,
				state: "done",
				assignee: "claude",
			});
			const ctx = ctxFor(
				await runOn(
					parent,
					{
						test: "touch gate-started; while [ ! -e gate-release ]; do sleep 0.01; done; exit 1",
					},
					false,
				),
			);
			const subject = {
				taskId: child.id,
				label: child.shortId ?? child.id,
				title: child.title,
				assignee: "claude",
			};
			const pending = Checks.gate(ctx, subject);
			try {
				for (let i = 0; i < 400 && !existsSync(join(repo, "gate-started")); i++)
					await Bun.sleep(5);
				expect(existsSync(join(repo, "gate-started"))).toBe(true);
				const changed = await Planner.updateTask(home, child.id, change);
				if (!changed.ok) throw changed.error;
				writeFileSync(join(repo, "gate-release"), "");
				const pass = await pending;
				await Checks.record(ctx, pass, subject);
				const after = await Planner.getTask(home, child.id);
				expect(after.ok && after.value).toEqual(changed.value);
				expect(await refsOf(child.id)).toEqual(["gate:test"]);
			} finally {
				writeFileSync(join(repo, "gate-release"), "");
				await pending;
			}
		});
	}

	it("a gate the run's stop kills does not reopen the subtask its session closed", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "done",
		});
		const ctx = ctxFor(
			await runOn(parent, { slow: "sleep 5; echo done" }, false),
		);
		const subject = {
			taskId: child.id,
			label: child.shortId ?? "",
			title: "child",
		};
		setTimeout(() => ctx.stopping.abort(), 100);
		const pass = await Checks.gate(ctx, subject);
		await Checks.record(ctx, pass, subject);

		expect(pass.results).toMatchObject([{ ok: false, exit: null }]);
		const task = await Planner.getTask(home, child.id);
		expect(task.ok && task.value?.state).toBe("done");
		expect(await refsOf(child.id)).toEqual(["gate:slow"]);
	});

	it("a run without a worktree commits nothing, and a checkpoint refuses the checkout", async () => {
		const parent = await add("parent");
		const ctx = ctxFor(await runOn(parent, { ok: "true" }, false));
		writeFileSync(join(repo, "wip.txt"), "the user's own work in progress\n");
		const before = head(repo);

		const pass = await Checks.gate(ctx, { label: "K", title: "parent" });
		expect(pass.ok).toBe(true);
		expect(pass.checkpoint).toBeUndefined();
		expect(head(repo)).toBe(before);

		const forced = await Worktree.checkpoint(repo, "should never land", git);
		expect(!forced.ok && forced.error.message).toContain(
			"not a linked worktree",
		);
		expect(head(repo)).toBe(before);
	});

	it("two sessions ending together get their gate passes one after the other", async () => {
		const parent = await add("parent");
		// Fails if another pass holds the directory's lock while this one runs.
		const exclusive = "mkdir .gate-lock || exit 9; sleep 0.2; rmdir .gate-lock";
		const ctx = ctxFor(await runOn(parent, { exclusive }, true));
		const [a, b] = await Promise.all([
			Checks.gate(ctx, { label: "K-2", title: "a" }),
			Checks.gate(ctx, { label: "K-3", title: "b" }),
		]);
		expect([a.ok, b.ok]).toEqual([true, true]);
		expect(ctx.run.gateRuns).toHaveLength(2);
	});
});

describe("Loop.rollback", () => {
	const HUMAN = "cabane://actor/human/david";

	it("resets the worktree to one of the run's checkpoints and refuses any other sha", async () => {
		const parent = await add("parent");
		const ctx = ctxFor(await runOn(parent, { ok: "true" }, true));
		const worktree = ctx.run.worktree ?? "";
		writeFileSync(join(worktree, "a.txt"), "a\n");
		const first = await Checks.gate(ctx, { label: "K", title: "first" });
		writeFileSync(join(worktree, "b.txt"), "b\n");
		await Checks.gate(ctx, { label: "K", title: "second" });
		writeFileSync(join(worktree, "c.txt"), "not committed\n");
		RunStore.write(home, { ...ctx.run, status: "completed" });

		const stranger = await Loop.rollback(
			{ home, actor: HUMAN, git },
			"run-1",
			head(repo),
		);
		expect(!stranger.ok && stranger.error.message).toContain(
			"not one of this run's checkpoints",
		);
		expect(existsSync(join(worktree, "b.txt"))).toBe(true);

		const sha = first.checkpoint ?? "";
		const reset = await Loop.rollback(
			{ home, actor: HUMAN, git },
			"run-1",
			sha.slice(0, 8),
		);
		expect(reset.ok && reset.value.sha).toBe(sha);
		expect(head(worktree)).toBe(sha);
		expect(existsSync(join(worktree, "a.txt"))).toBe(true);
		expect(existsSync(join(worktree, "b.txt"))).toBe(false);
		expect(existsSync(join(worktree, "c.txt"))).toBe(false);
		const events = RunStore.readEvents(home, "run-1");
		expect(events.ok && events.value.at(-1)?.type).toBe("rollback");
	});

	it("refuses while a session is working in the worktree", async () => {
		const parent = await add("parent");
		const ctx = ctxFor(await runOn(parent, { ok: "true" }, true));
		writeFileSync(join(ctx.run.worktree ?? "", "a.txt"), "a\n");
		const pass = await Checks.gate(ctx, { label: "K", title: "first" });
		RunStore.write(home, {
			...ctx.run,
			status: "running",
			pid: process.pid,
			claims: [
				{
					taskId: "t",
					shortId: "K-2",
					harness: "claude",
					lane: "claude:K-2",
					sessionId: "s",
					startedAt: new Date().toISOString(),
					continuations: 0,
				},
			],
		});
		const refused = await Loop.rollback(
			{ home, actor: HUMAN, git },
			"run-1",
			pass.checkpoint ?? "",
		);
		expect(!refused.ok && refused.error.message).toContain("still working");
	});
});

describe("Runner final checks", () => {
	// The real runner on a plan whose work is already done: it claims nothing, runs the gates once
	// in the run's worktree, commits the checkpoint and completes; a red gate stops it instead.
	const drive = async (gates: Record<string, string>) => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id, state: "done" });
		const run = await runOn(parent, gates, true);
		const ended = await Runner.run(run.id, {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
			overrides: { claude: { command: "/nonexistent/harness" } },
			tickMs: 5,
		});
		if (!ended.ok) throw ended.error;
		return ended.value;
	};

	it("completes once the gates are green, with a checkpoint in the worktree", async () => {
		const ended = await drive({ stamp: "echo green > gate.txt" });
		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(ended.claims).toEqual([]);
		expect(RunStore.checkpoints(ended)).toEqual([head(ended.worktree ?? "")]);
		expect(await refsOf(ended.parentId)).toEqual([
			"gate:stamp",
			`commit:${head(ended.worktree ?? "")}`,
		]);
	});

	it("stops for a human when the gates are red and no subtask is left to reopen", async () => {
		const ended = await drive({ test: "exit 1" });
		expect([ended.status, ended.exit?.reason]).toEqual([
			"stopped",
			"gates-red",
		]);
		expect(RunStore.checkpoints(ended)).toEqual([]);
	});
});
