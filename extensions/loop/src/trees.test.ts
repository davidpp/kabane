// Subtask claims in worktrees of their own, on the real runner, a disposable tracker and a real git
// repository whose run has a real worktree. A scripted ACP subprocess stands in for the model,
// through the real kabane tools: it writes the files its subtask is given, in the directory its
// session was started in, and closes the subtask. No model or MCP server is reached.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { ClaimTrees } from "./trees";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let repo = "";
// Where the scripted agent keeps its markers: what each subtask writes, who is live, what it saw.
let script = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));
const gitIn = (dir: string, ...args: string[]): string =>
	GitFixture.run(dir, args).trim();

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "loop-trees-")));
	home = join(root, "home");
	repo = join(root, "repo");
	script = join(root, "script");
	for (const dir of [
		home,
		repo,
		script,
		...["live", "started"].map((d) => join(script, d)),
	])
		mkdirSync(dir);
	GitFixture.run(repo, ["init", "-q"]);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	writeFileSync(join(repo, ".gitignore"), "target/\n");
	GitFixture.run(repo, ["add", "-A"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// A run drives real subprocesses and git through several claims.
const SLOW_MS = 30_000;

const label = (task: Task): string => task.shortId ?? task.id;

const add = async (title: string, parentTaskId?: string): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...(parentTaskId ? { parentTaskId } : {}),
	});
	if (!created.ok) throw created.error;
	return created.value;
};

// A parent and its subtasks, each told which files to write: `{ "a.txt": "a\n" }`.
const plan = async (
	...files: Record<string, string>[]
): Promise<{ parent: Task; subtasks: Task[] }> => {
	const parent = await add("parent");
	const subtasks: Task[] = [];
	for (const [i, writes] of files.entries()) {
		const subtask = await add(`subtask ${i + 1}`, parent.id);
		writeFileSync(
			join(script, `${label(subtask)}.files.json`),
			JSON.stringify(writes),
		);
		subtasks.push(subtask);
	}
	return { parent, subtasks };
};

// A run on `parent` in a worktree of the fixture repo, as `Loop.start` writes it.
const runOn = async (
	parent: Task,
	input: LoopConfig.Input = {},
): Promise<RunStore.Run> => {
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		...input,
	});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: label(parent),
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
	const dir = Worktree.dirFor(RunStore.paths(home, run.id).dir);
	const added = await Worktree.add(repo, dir, "kabane-loop/run-1", git);
	if (!added.ok) throw added.error;
	const written = RunStore.write(home, { ...run, worktree: dir });
	if (!written.ok) throw written.error;
	return written.value;
};

// Each prompt: note the session as live (and how many were, itself included) and where it runs,
// write its subtask's files there (or, when the runner says its branch did not merge, the
// resolution in `<task>.resolve.json`), wait until `together` sessions have started when that
// marker says so, then close the subtask. Reopened, a subtask with a `<task>.cancel` marker
// cancels itself instead.
const AGENT = `
import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
const [home, script] = process.argv.slice(2);
const done = KABANE_TOOLS.find((t) => t.name === "kabane_done");
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
let task;
createInterface({ input: process.stdin }).on("line", async (line) => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method !== "session/prompt") return;
 const text = message.params.prompt.map((p) => p.text ?? "").join("\\n");
 task ??= /Your subtask is ([^.]+)\\./.exec(text)?.[1];
 if (!task) process.exit(2);
 const live = join(script, "live", task);
 writeFileSync(live, "");
 writeFileSync(join(script, "started", task), "");
 appendFileSync(join(script, task + ".live"), readdirSync(join(script, "live")).length + "\\n");
 appendFileSync(join(script, task + ".cwd"), process.cwd() + "\\n");
 appendFileSync(join(script, task + ".prompts"), JSON.stringify(text) + "\\n");
 if (text.includes("then reopened") && existsSync(join(script, task + ".cancel"))) {
  rmSync(live, { force: true });
  const edit = KABANE_TOOLS.find((t) => t.name === "kabane_edit");
  const cancelled = await edit.handler({ id: task, state: "cancelled" }, { basePath: home, actor: "cabane://actor/agent/gemini", scopeRequired: false });
  if (!cancelled.ok) process.exit(3);
  return reply(message.id, { stopReason: "end_turn" });
 }
 const conflicted = text.includes("did not merge into the run's branch");
 const writes = JSON.parse(readFileSync(join(script, task + (conflicted ? ".resolve.json" : ".files.json")), "utf8"));
 for (const [path, content] of Object.entries(writes)) writeFileSync(path, content);
 const together = join(script, "together");
 const until = Date.now() + 5000;
 while (existsSync(together) && Date.now() < until && readdirSync(join(script, "started")).length < Number(readFileSync(together, "utf8"))) await Bun.sleep(5);
 rmSync(live, { force: true });
 const closed = await done.handler({ id: task }, { basePath: home, actor: "cabane://actor/agent/gemini", scopeRequired: false });
 if (!closed.ok) process.exit(1);
 reply(message.id, { stopReason: "end_turn" });
});
`;

// `harness` none: a harness that is not there, so every session fails before it starts.
const drive = async (
	harness: "scripted" | "none" = "scripted",
): Promise<RunStore.Run> => {
	const agent = join(root, "agent.mjs");
	writeFileSync(agent, AGENT);
	const ended = await Runner.run("run-1", {
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		pid: process.pid,
		git,
		overrides: {
			gemini:
				harness === "scripted"
					? { command: process.execPath, args: [agent, home, script] }
					: { command: "/nonexistent/harness" },
		},
		tickMs: 5,
	});
	if (!ended.ok) throw ended.error;
	return ended.value;
};

const lines = (file: string): string[] =>
	existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];

// The most sessions live at once, as each one counted them when it started.
const mostLive = (tasks: readonly Task[]): number =>
	Math.max(
		...tasks.flatMap((t) =>
			lines(join(script, `${label(t)}.live`)).map(Number),
		),
	);

const events = (type: string): RunStore.Event[] => {
	const read = RunStore.readEvents(home, "run-1");
	return read.ok ? read.value.filter((e) => e.type === type) : [];
};

// The files a commit changed, against its first parent.
const changed = (dir: string, sha: string): string[] =>
	gitIn(dir, "diff", "--name-only", `${sha}^1`, sha).split("\n");

const passFor = (run: RunStore.Run, task: Task) =>
	run.gateRuns.filter((r) => r.taskId === task.id);

describe("Subtasks in worktrees of their own", () => {
	it(
		"runs two disjoint subtasks at once, each in its own worktree, and merges both",
		async () => {
			const { parent, subtasks } = await plan(
				{ "a.txt": "a\n" },
				{ "b.txt": "b\n" },
			);
			const [a, b] = subtasks;
			if (!a || !b) throw new Error("no subtasks");
			writeFileSync(join(script, "together"), "2");
			// No concurrency set: with a worktree each, it is 2.
			const run = await runOn(parent, { gates: { both: "test -f README.md" } });
			expect(RunStore.concurrency(run)).toBe(2);

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(mostLive([a, b])).toBe(2);
			const worktree = ended.worktree ?? "";
			const dirs = ended.claims.map((c) => c.worktree);
			expect(new Set(dirs).size).toBe(2);
			for (const task of [a, b]) {
				const claim = ended.claims.find((c) => c.taskId === task.id);
				// Its session ran in its own worktree, never the run's.
				expect(lines(join(script, `${label(task)}.cwd`))).toEqual([
					claim?.worktree ?? "missing",
				]);
				expect(claim?.worktree).not.toBe(worktree);
			}
			// Both merged into the run's branch, which has both files and nothing uncommitted.
			expect(gitIn(worktree, "show", "HEAD:a.txt")).toBe("a");
			expect(gitIn(worktree, "show", "HEAD:b.txt")).toBe("b");
			expect(gitIn(worktree, "status", "--porcelain")).toBe("");
			expect(
				events("merged")
					.map((e) => e.task)
					.sort(),
			).toEqual([label(a), label(b)].sort());
			// Each checkpoint has only its own subtask's file, and the run's checkpoints are the merges.
			for (const [task, file] of [
				[a, "a.txt"],
				[b, "b.txt"],
			] as const) {
				const [pass] = passFor(ended, task);
				expect(pass?.ok).toBe(true);
				expect(changed(worktree, pass?.checkpoint ?? "")).toEqual([file]);
				expect(gitIn(worktree, "rev-parse", `${pass?.merged}^2`)).toBe(
					pass?.checkpoint ?? "",
				);
			}
			expect(RunStore.checkpoints(ended)).toEqual(
				ended.gateRuns.flatMap((r) => (r.merged ? [r.merged] : [])),
			);
			// The run is over: its free worktrees are removed, and their branches with the merges.
			expect(ClaimTrees.all(ended)).toEqual([]);
			for (const dir of dirs) expect(existsSync(dir ?? "")).toBe(false);
			expect(gitIn(repo, "branch", "--list", "kabane-loop/run-1--*")).toBe("");
		},
		SLOW_MS,
	);

	it(
		"reopens a subtask whose branch conflicts, with the conflict in its brief, and merges its resolution",
		async () => {
			const { parent, subtasks } = await plan(
				{ "shared.txt": "from the first\n" },
				{ "shared.txt": "from the second\n" },
			);
			const [first, second] = subtasks;
			if (!first || !second) throw new Error("no subtasks");
			writeFileSync(join(script, "together"), "2");
			for (const task of subtasks)
				writeFileSync(
					join(script, `${label(task)}.resolve.json`),
					JSON.stringify({ "shared.txt": "from both\n" }),
				);
			await runOn(parent);

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			// Whichever merged second conflicted, and only it was reopened.
			const [conflict, ...others] = events("merge_conflict");
			expect(others).toEqual([]);
			const loser = subtasks.find((t) => label(t) === conflict?.task);
			if (!loser) throw new Error("no conflict");
			expect(conflict?.summary).toContain("conflicts in shared.txt");
			const reopened = events("reopened").map((e) => e.summary);
			expect(reopened).toHaveLength(1);
			expect(reopened[0]).toStartWith(
				`${label(loser)} reopened: merge failed (exit 1)`,
			);
			// The retry's brief names the conflict and that it is left in its worktree to resolve.
			const prompts = lines(join(script, `${label(loser)}.prompts`)).map((l) =>
				String(JSON.parse(l)),
			);
			expect(prompts).toHaveLength(2);
			expect(prompts[1]).toContain("the `merge` gate");
			expect(prompts[1]).toContain("conflicts in shared.txt");
			expect(prompts[1]).toContain("left for you: resolve them");
			// It retried in the worktree it held, and its resolution merged.
			const claims = ended.claims.filter((c) => c.taskId === loser.id);
			expect(claims.map((c) => c.worktree)).toEqual([
				claims[0]?.worktree,
				claims[0]?.worktree,
			]);
			const worktree = ended.worktree ?? "";
			expect(gitIn(worktree, "show", "HEAD:shared.txt")).toBe("from both");
			expect(passFor(ended, loser).map((p) => p.ok)).toEqual([false, true]);
		},
		SLOW_MS,
	);

	it(
		"with isolation shared, works every subtask in the run's tree, one at a time",
		async () => {
			const { parent, subtasks } = await plan(
				{ "a.txt": "a\n" },
				{ "b.txt": "b\n" },
			);
			const run = await runOn(parent, { isolation: "shared" });
			expect(RunStore.concurrency(run)).toBe(1);

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(mostLive(subtasks)).toBe(1);
			const worktree = ended.worktree ?? "";
			expect(ended.claims.map((c) => c.worktree)).toEqual([
				undefined,
				undefined,
			]);
			expect(ClaimTrees.all(ended)).toEqual([]);
			for (const task of subtasks)
				expect(lines(join(script, `${label(task)}.cwd`))).toEqual([worktree]);
			expect(events("merged")).toEqual([]);
			// The checkpoints are commits on the run's branch itself, one per subtask.
			expect(RunStore.checkpoints(ended)).toEqual(
				ended.gateRuns.flatMap((r) => (r.checkpoint ? [r.checkpoint] : [])),
			);
			expect(gitIn(worktree, "rev-list", "--merges", "HEAD")).toBe("");
			expect(gitIn(worktree, "show", "HEAD:a.txt")).toBe("a");
			expect(gitIn(worktree, "show", "HEAD:b.txt")).toBe("b");
		},
		SLOW_MS,
	);

	// The setup notes whether a build artifact git ignores was already there: warm, or built cold.
	const SETUP = `if [ -f target/artifact ]; then echo warm >> ${"$"}LOG; else mkdir -p target && echo built > target/artifact && echo cold >> ${"$"}LOG; fi`;

	for (const reuse of [true, false])
		it(
			`${reuse ? "keeps" : "removes"} a subtask's worktree, and its ignored build output, across claims with reuse ${reuse}`,
			async () => {
				const { parent, subtasks } = await plan(
					{ "a.txt": "a\n" },
					{ "b.txt": "b\n" },
				);
				const log = join(script, "setup.log");
				// One at a time, an explicit concurrency over the default of 2, so the second subtask's
				// claim comes after the first's work merged.
				await runOn(parent, {
					setup: SETUP.replaceAll("$LOG", log),
					reuse,
					budget: { concurrency: 1 },
				});

				const ended = await drive();

				expect([ended.status, ended.exit?.reason]).toEqual([
					"completed",
					"plan-done",
				]);
				expect(mostLive(subtasks)).toBe(1);
				expect(lines(log)).toEqual(reuse ? ["cold", "warm"] : ["cold", "cold"]);
				// The same worktree each time, reset to the run's HEAD: the first's file was there, merged.
				const [one, two] = ended.claims.map((c) => c.worktree);
				expect(one).toBe(two);
				const worktree = ended.worktree ?? "";
				expect(gitIn(worktree, "show", "HEAD:a.txt")).toBe("a");
				expect(gitIn(worktree, "show", "HEAD:b.txt")).toBe("b");
			},
			SLOW_MS,
		);

	it(
		"never keeps more worktrees than maxWorktrees, the other subtask waiting for one",
		async () => {
			const { parent, subtasks } = await plan(
				{ "a.txt": "a\n" },
				{ "b.txt": "b\n" },
			);
			const run = await runOn(parent, { maxWorktrees: 1 });
			expect([RunStore.concurrency(run), ClaimTrees.cap(run)]).toEqual([2, 1]);

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(mostLive(subtasks)).toBe(1);
			expect(new Set(ended.claims.map((c) => c.worktree)).size).toBe(1);
			expect(
				events("waiting").some((e) =>
					e.summary.startsWith(
						"waiting for a worktree: the run keeps at most 1",
					),
				),
			).toBe(true);
			const treesDir = join(RunStore.paths(home, "run-1").dir, "trees");
			expect(existsSync(treesDir) ? readdirSync(treesDir) : []).toEqual([]);
		},
		SLOW_MS,
	);

	it(
		"frees the worktree of a subtask cancelled before its work merged, for the one waiting",
		async () => {
			const { parent, subtasks } = await plan(
				{ "red.txt": "fails the gate\n" },
				{ "b.txt": "b\n" },
			);
			const [first, second] = subtasks;
			if (!first || !second) throw new Error("no subtasks");
			writeFileSync(join(script, `${label(first)}.cancel`), "");
			await runOn(parent, {
				gates: { clean: "test ! -f red.txt" },
				maxWorktrees: 1,
				budget: { concurrency: 1 },
			});

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(
				events("warning").map((e) =>
					e.summary.replace(/\/\S+\/trees\//, "trees/"),
				),
			).toContain(
				`worktree trees/1 freed: ${label(first)} was cancelled before its work merged; its branch kabane-loop/run-1--${label(first).toLowerCase()} keeps what it committed`,
			);
			// The second subtask worked in the same worktree, reset: the first's file is not in its work.
			expect(new Set(ended.claims.map((c) => c.worktree)).size).toBe(1);
			const worktree = ended.worktree ?? "";
			expect(gitIn(worktree, "show", "HEAD:b.txt")).toBe("b");
			expect(existsSync(join(worktree, "red.txt"))).toBe(false);
			expect(passFor(ended, second).map((p) => p.ok)).toEqual([true]);
		},
		SLOW_MS,
	);

	it(
		"keeps a subtask's worktree and work when a hook refuses its checkpoint, and merges its retry's",
		async () => {
			const { parent, subtasks } = await plan({ "a.txt": "a\n" });
			const [only] = subtasks;
			if (!only) throw new Error("no subtask");
			// The repository's own pre-commit hook refuses the first commit, as a lint hook would.
			const once = join(script, "refused-once");
			const hooks = join(repo, ".git", "hooks");
			mkdirSync(hooks, { recursive: true });
			writeFileSync(
				join(hooks, "pre-commit"),
				`#!/bin/sh\ntest -f ${once} && exit 0\ntouch ${once}\necho "lint: a.txt is not formatted" >&2\nexit 1\n`,
				{ mode: 0o755 },
			);
			await runOn(parent);

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			const [refused, retried] = passFor(ended, only);
			expect([refused?.ok, retried?.ok]).toEqual([false, true]);
			expect(refused?.merged).toBeUndefined();
			expect(refused?.results.at(-1)?.name).toBe("checkpoint");
			// The retry worked in the worktree it held, told why its checkpoint was refused.
			const claims = ended.claims.filter((c) => c.taskId === only.id);
			expect(claims.map((c) => c.worktree)).toEqual([
				claims[0]?.worktree,
				claims[0]?.worktree,
			]);
			const prompts = lines(join(script, `${label(only)}.prompts`)).map((l) =>
				String(JSON.parse(l)),
			);
			expect(prompts[1]).toContain("the `checkpoint` gate");
			expect(prompts[1]).toContain("lint: a.txt is not formatted");
			expect(gitIn(ended.worktree ?? "", "show", "HEAD:a.txt")).toBe("a");
		},
		SLOW_MS,
	);

	// Stop the run after `ms` should it never end on its own, so a run that waits forever fails
	// its test on its exit rather than on the test's timeout.
	const stopAfter = (ms: number): (() => void) => {
		const timer = setTimeout(
			() =>
				RunStore.appendInbox(home, "run-1", {
					kind: "stop",
					at: new Date().toISOString(),
				}),
			ms,
		);
		return () => clearTimeout(timer);
	};

	it(
		"claims a subtask again in the worktree it holds while an older one waits for a worktree",
		async () => {
			const { parent, subtasks } = await plan(
				{ "a.txt": "a\n" },
				{ "b.txt": "b\n" },
			);
			const [older, younger] = subtasks;
			if (!older || !younger) throw new Error("no subtasks");
			// Red the first time it runs, green after.
			const once = join(script, "failed-once");
			await runOn(parent, {
				gates: { once: `test -f ${once} || { touch ${once}; exit 1; }` },
				maxWorktrees: 1,
				budget: { concurrency: 1 },
			});
			// A human asked for the younger one first, as `kabane loop next` does.
			RunStore.appendInbox(home, "run-1", {
				kind: "next",
				at: new Date().toISOString(),
				taskId: younger.id,
				task: label(younger),
			});

			const stop = stopAfter(10_000);
			const ended = await drive().finally(stop);

			expect([ended.status, ended.exit?.reason]).toEqual([
				"completed",
				"plan-done",
			]);
			expect(ended.claims.map((c) => c.taskId)).toEqual([
				younger.id,
				younger.id,
				older.id,
			]);
			expect(passFor(ended, younger).map((p) => p.ok)).toEqual([false, true]);
			expect(new Set(ended.claims.map((c) => c.worktree)).size).toBe(1);
		},
		SLOW_MS,
	);

	it(
		"removes, as the run ends, the worktrees whose sessions left nothing, and keeps one with work",
		async () => {
			const { parent, subtasks } = await plan(
				{ "a.txt": "a\n" },
				{ "b.txt": "b\n" },
			);
			await runOn(parent, { stallAfter: 1 });

			const ended = await drive("none");

			expect([ended.status, ended.exit?.reason]).toEqual([
				"stopped",
				"stalled",
			]);
			expect(ended.claims.length).toBeGreaterThan(0);
			expect(ClaimTrees.all(ended)).toEqual([]);
			expect(
				events("warning").filter((e) => e.summary.includes("left with work")),
			).toEqual([]);
			expect(gitIn(repo, "branch", "--list", "kabane-loop/run-1--*")).toBe("");
			expect(subtasks).toHaveLength(2);
		},
		SLOW_MS,
	);

	it(
		"leaves a worktree holding work that never merged, with its branch, and says so",
		async () => {
			const { parent, subtasks } = await plan({
				"red.txt": "fails the gate\n",
			});
			const [only] = subtasks;
			if (!only) throw new Error("no subtask");
			await runOn(parent, {
				gates: { clean: "test ! -f red.txt" },
				stallAfter: 1,
			});

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"stopped",
				"stalled",
			]);
			const [tree, ...others] = ClaimTrees.all(ended);
			expect(others).toEqual([]);
			const branch = `kabane-loop/run-1--${label(only).toLowerCase()}`;
			expect(tree?.held).toEqual({ taskId: only.id, branch });
			expect(readFileSync(join(tree?.dir ?? "", "red.txt"), "utf8")).toBe(
				"fails the gate\n",
			);
			expect(
				gitIn(repo, "branch", "--list", "--format=%(refname:short)", branch),
			).toBe(branch);
			expect(events("warning").map((e) => e.summary)).toContain(
				`worktree ${tree?.dir} is left with work on branch ${branch} that never merged into kabane-loop/run-1`,
			);
		},
		SLOW_MS,
	);

	it(
		"stops the run when a worktree's setup fails, before any session starts",
		async () => {
			const { parent } = await plan({ "a.txt": "a\n" });
			await runOn(parent, { setup: "echo no network; exit 3" });

			const ended = await drive();

			expect([ended.status, ended.exit?.reason]).toEqual([
				"stopped",
				"worktree-not-readied",
			]);
			expect(ended.exit?.detail).toContain("setup failed (exit 3)");
			expect(ended.exit?.detail).toContain("no network");
			expect(ended.claims).toEqual([]);
			// Freed again, and removed once the run ended.
			expect(ClaimTrees.all(ended)).toEqual([]);
		},
		SLOW_MS,
	);
});

describe("RunStore.concurrency", () => {
	const run = (input: LoopConfig.Input, worktree?: string): RunStore.Run => {
		const config = LoopConfig.Schema.safeParse(input);
		if (!config.success) throw config.error;
		return {
			version: 1,
			id: "run-1",
			parentId: "P",
			parentShortId: "P-1",
			projectDir: repo,
			...(worktree ? { worktree } : {}),
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
	};

	it("follows isolation unless set, and a set value wins either way", () => {
		expect(RunStore.concurrency(run({}, "/w"))).toBe(2);
		expect(RunStore.concurrency(run({ isolation: "shared" }, "/w"))).toBe(1);
		// Without a worktree to cut theirs from, subtasks share the one tree.
		expect(RunStore.concurrency(run({}))).toBe(1);
		for (const isolation of ["worktree", "shared"] as const)
			expect(
				RunStore.concurrency(
					run({ isolation, budget: { concurrency: 3 } }, "/w"),
				),
			).toBe(3);
		expect(
			RunStore.concurrency(run({ budget: { concurrency: 1 } }, "/w")),
		).toBe(1);
	});
});
