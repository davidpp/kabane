// Gates, checkpoints and rollback against a real tracker and a real git repository with a real
// worktree. Only git's config is the fixture's (an identity, no signing), as in every test.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Brief } from "./brief";
import { Checks } from "./checks";
import { Claims } from "./claims";
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
	extra: LoopConfig.Input = {},
): Promise<RunStore.Run> => {
	const config = LoopConfig.Schema.safeParse({
		gates,
		worktree,
		...extra,
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
	const added = await Worktree.add(repo, dir, "kabane-loop/run-1", git);
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
			{
				runId: "run-1",
				parent,
				task: child,
				gates: Object.keys(ctx.run.config.gates),
				concurrent: false,
				...(retry ? { retry } : {}),
			},
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

	it("refuses a checkpoint rewritten by landing's rebase without changing the worktree", async () => {
		const parent = await add("parent");
		const ctx = ctxFor(await runOn(parent, { ok: "true" }, true));
		const dir = ctx.run.worktree ?? "";
		writeFileSync(join(dir, "work.txt"), "checkpoint\n");
		const pass = await Checks.gate(ctx, { label: "K", title: "checkpoint" });
		RunStore.write(home, { ...ctx.run, status: "completed" });
		const remote = join(root, "remote.git");
		GitFixture.run(root, ["init", "-q", "--bare", remote]);
		GitFixture.run(repo, ["remote", "add", "origin", remote]);
		writeFileSync(join(repo, "upstream.txt"), "base moved\n");
		GitFixture.run(repo, ["add", "-A"]);
		GitFixture.run(repo, ["commit", "-q", "-m", "base moved"]);
		GitFixture.run(repo, ["push", "-q", "origin", "HEAD:main"]);
		GitFixture.run(dir, ["fetch", "-q", "origin", "main"]);
		// Landing's rebase, done here with the fixture's git: it writes commits, so it needs a
		// committer identity, which a CI runner's ambient git config does not have.
		GitFixture.run(dir, ["rebase", "-q", "FETCH_HEAD"]);
		const tip = head(dir);
		expect(tip).not.toBe(pass.checkpoint);
		writeFileSync(join(dir, "work.txt"), "local edit\n");
		writeFileSync(join(dir, "untracked.txt"), "keep me\n");
		const events = RunStore.readEvents(home, ctx.run.id);

		const refused = await Loop.rollback(
			{ home, actor: HUMAN },
			ctx.run.id,
			(pass.checkpoint ?? "").slice(0, 8),
		);
		expect(!refused.ok && refused.error.message).toContain("landed (rebased)");
		expect(head(dir)).toBe(tip);
		expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("local edit\n");
		expect(existsSync(join(dir, "upstream.txt"))).toBe(true);
		expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
		expect(RunStore.readEvents(home, ctx.run.id)).toEqual(events);
		expect(Worktree.lockedBy(dir)).toBeUndefined();
	});

	it("refuses rollback while landing holds the worktree lock, then releases its own lock", async () => {
		const parent = await add("parent");
		const ctx = ctxFor(await runOn(parent, { ok: "true" }, true));
		const dir = ctx.run.worktree ?? "";
		writeFileSync(join(dir, "work.txt"), "checkpoint\n");
		const pass = await Checks.gate(ctx, { label: "K", title: "checkpoint" });
		RunStore.write(home, { ...ctx.run, status: "completed" });
		writeFileSync(join(dir, "untracked.txt"), "keep while locked\n");
		const held = Worktree.lock(dir, "kabane loop land run-1");
		if (!held.ok) throw held.error;
		try {
			const refused = await Loop.rollback(
				{ home, actor: HUMAN },
				ctx.run.id,
				pass.checkpoint ?? "",
			);
			expect(!refused.ok && refused.error.message).toContain(
				"kabane loop land run-1",
			);
			expect(existsSync(join(dir, "untracked.txt"))).toBe(true);
		} finally {
			held.value();
		}
		expect(
			(
				await Loop.rollback(
					{ home, actor: HUMAN },
					ctx.run.id,
					pass.checkpoint ?? "",
				)
			).ok,
		).toBe(true);
		expect(existsSync(join(dir, "untracked.txt"))).toBe(false);
		expect(Worktree.lockedBy(dir)).toBeUndefined();
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
			"loop:run-1",
			"gate:stamp",
			`commit:${head(ended.worktree ?? "")}`,
		]);
		// The summary on the parent names the branch to merge.
		const comments = await Planner.getComments(home, ended.parentId);
		expect(comments.ok && comments.value.at(-1)?.content).toEndWith(
			`Merge branch \`kabane-loop/run-1\` from the worktree \`${ended.worktree}\`, then close ${ended.parentShortId}.`,
		);
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

describe("A worktree run without gates", () => {
	// An implementer that does the work and closes its subtask, and never commits: the checkpoint
	// has to come from the run. No model or MCP server is reached; the tracker is written directly.
	const IMPLEMENTER = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
const [home] = process.argv.slice(2);
const done = KABANE_TOOLS.find((t) => t.name === "kabane_done");
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", async (line) => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method !== "session/prompt") return;
 const text = message.params.prompt.map((p) => p.text ?? "").join("\\n");
 const task = /Your subtask is ([^.]+)\\./.exec(text)?.[1];
 writeFileSync("feature.txt", "made by " + task + "\\n");
 const closed = await done.handler({ id: task }, { basePath: home, actor: "cabane://actor/agent/gemini", scopeRequired: false });
 if (!closed.ok) process.exit(1);
 reply(message.id, { stopReason: "end_turn" });
});
`;

	// Shared, the subtask's checkpoint is the run's HEAD; in a worktree of its own, the merge of its
	// branch is, and its checkpoint is that merge's second parent.
	for (const isolation of ["shared", "worktree"] as const)
		it(`commits each finished subtask as a checkpoint, isolation ${isolation}`, async () => {
			const parent = await add("parent");
			await add("child", { parentTaskId: parent.id });
			// gemini, as in runner-scheduling.test.ts: the claude profile needs a claude on PATH, and CI
			// has none.
			const run = await runOn(parent, {}, true, {
				implementer: "gemini",
				isolation,
			});
			const agent = join(root, "implementer.mjs");
			writeFileSync(agent, IMPLEMENTER);
			const ended = await Runner.run(run.id, {
				home,
				basePath: home,
				kabaneBin: "/nonexistent/kabane",
				pid: process.pid,
				git,
				overrides: {
					gemini: { command: process.execPath, args: [agent, home] },
				},
				tickMs: 5,
			});
			if (!ended.ok) throw ended.error;

			const worktree = ended.value.worktree ?? "";
			expect([ended.value.status, ended.value.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(RunStore.checkpoints(ended.value)).toEqual([head(worktree)]);
			expect(GitFixture.run(worktree, ["status", "--porcelain"])).toBe("");
			const checkpoint = isolation === "shared" ? "HEAD" : "HEAD^2";
			expect(
				GitFixture.run(worktree, [
					"show",
					"--name-only",
					"--format=%b",
					checkpoint,
				]),
			).toContain("No gates configured.");
			expect(
				GitFixture.run(worktree, ["show", "HEAD:feature.txt"]),
			).toStartWith("made by ");
		});
});

describe("Claims.recover after a runner died during a subtask's pass", () => {
	const red = (taskId: string, at: string): Gates.Run => ({
		at,
		taskId,
		results: [
			{
				name: "test",
				command: "exit 1",
				ok: false,
				exit: 1,
				ms: 5,
				tail: "1 failed",
			},
		],
		ok: false,
		tree: "tree",
	});

	// What a runner killed after the session closed its subtask leaves: the claim still open on a
	// done subtask, the work in the run's directory, and the passes it had saved.
	const recoverOrphan = async (
		gates: Record<string, string>,
		worktree: boolean,
		saved: (taskId: string, startedAt: string) => Gates.Run[] = () => [],
	) => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "done",
			assignee: "claude",
		});
		const session = await Planner.startSession(home, {
			taskId: child.id,
			agent: "claude",
			externalRef: RunStore.sessionRef("run-1"),
		});
		if (!session.ok) throw session.error;
		const startedAt = new Date().toISOString();
		const run = await runOn(parent, gates, worktree);
		writeFileSync(join(RunStore.sessionDir(run), "feature.txt"), "made\n");
		const ctx = ctxFor({
			...run,
			status: "running",
			claims: [
				{
					taskId: child.id,
					shortId: child.shortId ?? child.id,
					harness: "claude",
					lane: child.shortId ?? child.id,
					sessionId: session.value.id,
					startedAt,
					continuations: 0,
				},
			],
			gateRuns: saved(child.id, startedAt),
		});
		await Claims.recover(ctx);
		const after = await Planner.getTask(home, child.id);
		return { ctx, child, state: after.ok ? after.value?.state : undefined };
	};

	it("runs the gates it never finished, and a red one reopens the subtask", async () => {
		const { ctx, child, state } = await recoverOrphan(
			{ test: "exit 1" },
			false,
		);
		expect(ctx.run.gateRuns.map((r) => [r.taskId, r.ok])).toEqual([
			[child.id, false],
		]);
		expect(state).toBe("next");
		expect(await refsOf(child.id)).toContain("gate:test");
		expect(ctx.run.claims[0]?.outcome).toBe("interrupted");
	});

	it("records a pass it ran but never recorded, without running it again", async () => {
		const { ctx, child, state } = await recoverOrphan(
			{ test: "touch ran-again; exit 1" },
			false,
			(taskId, startedAt) => [red(taskId, startedAt)],
		);
		expect(ctx.run.gateRuns).toHaveLength(1);
		expect(existsSync(join(repo, "ran-again"))).toBe(false);
		expect(state).toBe("next");
		expect(await refsOf(child.id)).toContain("gate:test");
	});

	it("leaves an earlier claim's pass alone and runs this one's", async () => {
		const { ctx, state } = await recoverOrphan(
			{ test: "true" },
			false,
			(taskId) => [red(taskId, "2026-01-01T00:00:00.000Z")],
		);
		expect(ctx.run.gateRuns.map((r) => r.ok)).toEqual([false, true]);
		expect(state).toBe("done");
	});

	it("commits the subtask's checkpoint in a worktree run without gates", async () => {
		const { ctx, child, state } = await recoverOrphan({}, true);
		const worktree = ctx.run.worktree ?? "";
		expect(RunStore.checkpoints(ctx.run)).toEqual([head(worktree)]);
		expect(ctx.run.gateRuns.map((r) => r.taskId)).toEqual([child.id]);
		expect(GitFixture.run(worktree, ["status", "--porcelain"])).toBe("");
		expect(state).toBe("done");
		expect(await refsOf(child.id)).toContain(`commit:${head(worktree)}`);
	});
});

describe("A single-issue run", () => {
	// An implementer that works the one issue it is given and closes it, appending a line per
	// attempt; the gate passes only from the second, so the red pass has to reopen the issue and
	// the run has to claim it again. No model or MCP server is reached.
	const IMPLEMENTER = `
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
const [home, prompts] = process.argv.slice(2);
const done = KABANE_TOOLS.find((t) => t.name === "kabane_done");
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", async (line) => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method !== "session/prompt") return;
 const text = message.params.prompt.map((p) => p.text ?? "").join("\\n");
 appendFileSync(prompts, JSON.stringify(text) + "\\n");
 const task = /Your issue is ([^.]+)\\./.exec(text)?.[1];
 if (!task) process.exit(1);
 appendFileSync("attempts.txt", "attempt\\n");
 const closed = await done.handler({ id: task }, { basePath: home, actor: "cabane://actor/agent/gemini", scopeRequired: false });
 if (!closed.ok) process.exit(1);
 reply(message.id, { stopReason: "end_turn" });
});
`;

	it("claims the issue itself, reopens it on a red gate, and completes it in the worktree", async () => {
		const issue = await add("lone");
		const run = await runOn(
			issue,
			{ second: 'test "$(wc -l < attempts.txt)" -ge 2' },
			true,
			{ implementer: "gemini" },
		);
		const agent = join(root, "implementer.mjs");
		const prompts = join(root, "prompts.jsonl");
		writeFileSync(agent, IMPLEMENTER);
		const ended = await Runner.run(run.id, {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
			overrides: {
				gemini: { command: process.execPath, args: [agent, home, prompts] },
			},
			tickMs: 5,
		});
		if (!ended.ok) throw ended.error;

		const label = issue.shortId ?? issue.id;
		expect([ended.value.status, ended.value.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		// The same task, claimed twice under the claim's own lanes: never as a parent.
		expect(
			ended.value.claims.map((c) => [c.taskId, c.lane, c.outcome]),
		).toEqual([
			[issue.id, label, "done"],
			[issue.id, `${label}#2`, "done"],
		]);
		const events = RunStore.readEvents(home, run.id);
		expect(
			events.ok && events.value.filter((e) => e.type === "reopened").length,
		).toBe(1);
		const sent = readFileSync(prompts, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain(`${label} was closed before, then reopened`);
		for (const prompt of sent) expect(prompt).not.toContain("subtasks of");

		const after = await Planner.getTask(home, issue.id);
		expect(after.ok && [after.value?.state, after.value?.needsReview]).toEqual([
			"done",
			true,
		]);
		const worktree = ended.value.worktree ?? "";
		expect(RunStore.checkpoints(ended.value)).toEqual([head(worktree)]);
		const comments = await Planner.getComments(home, issue.id);
		expect(comments.ok && comments.value.at(-1)?.content).toEndWith(
			`Merge branch \`kabane-loop/run-1\` from the worktree \`${worktree}\`.`,
		);
	});
});
