// A single issue with a checklist, on the real runner, a disposable tracker with the checklist
// module and a real git worktree. A scripted ACP subprocess stands in for the model, through the
// real kabane tools: each turn it works the item its prompt points at, ticks it, and, as told,
// calls kabane_done once every item is ticked or after each one.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checklist, checklistModule } from "@cabane/checklist";
import { Planner, type Task, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { configureTestRuntime } from "@cabane/core/testing";
import { Checklists } from "./checklists";
import { Checks } from "./checks";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let repo = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-checklist-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	GitFixture.run(repo, ["add", "-A"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "first"]);
	configureTestRuntime("", { modules: [checklistModule] });
	await Planner.init(home);
});

afterEach(() => {
	configureTestRuntime();
	rmSync(root, { recursive: true, force: true });
});

const STEPS = ["Parse the input", "Validate it", "Write the output"];

// The issue, with its checklist in list order.
const issueWithSteps = async (): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title: "stepwise",
		kind: "issue",
		state: "next",
	});
	if (!created.ok) throw created.error;
	const added = await Checklist.add(home, {
		id: created.value.id,
		items: STEPS,
	});
	if (!added.ok) throw added.error;
	return created.value;
};

const items = async (task: Task) => {
	const listed = await Checklist.list(home, task.id);
	if (!listed.ok) throw listed.error;
	return listed.value;
};

// A run on `issue` in a worktree of the fixture repo, as `Loop.start` writes it.
const runOn = async (
	issue: Task,
	extra: Partial<RunStore.Run> = {},
	input: LoopConfig.Input = {},
): Promise<RunStore.Run> => {
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		gates: { worked: "test -f work.txt" },
		...input,
	});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: issue.id,
		parentShortId: issue.shortId ?? issue.id,
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
	const written = RunStore.write(home, { ...run, worktree: dir, ...extra });
	if (!written.ok) throw written.error;
	return written.value;
};

// `each` calls kabane_done after every item it ticks; `last` only once the receipt shows all ticked;
// `human` ticks one, then has a human close the issue. Its writes are the session's own actor's, as
// the real MCP server's `--as` makes them. A task with no checklist is closed at once, and one with
// a `<task>.wait` marker holds its turn until `<task>.release` exists. No model or MCP server is
// reached.
const AGENT = `
import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";
import { configureTestRuntime } from ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
import { checklistModule } from ${JSON.stringify(import.meta.resolve("@cabane/checklist"))};
const AGENT_ACTOR = "cabane://actor/agent/gemini";
let actor = AGENT_ACTOR;
configureTestRuntime("", { modules: [checklistModule], actor: () => actor });
const [home, prompts, done] = process.argv.slice(2);
let task;
const ctx = { basePath: home, actor: AGENT_ACTOR, scopeRequired: false };
const tool = async (name, args) => {
 const definition = [...KABANE_TOOLS, ...checklistModule.tools].find((t) => t.name === name);
 const result = await definition.handler(args, ctx);
 if (!result.ok) process.exit(1);
 return result.value;
};
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", async (line) => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method !== "session/prompt") return;
 const text = message.params.prompt.map((p) => p.text ?? "").join("\\n");
 appendFileSync(prompts, JSON.stringify(text) + "\\n");
 task ??= /Your (?:issue|subtask) is ([^.]+)\\./.exec(text)?.[1];
 if (!task) process.exit(2);
 while (existsSync(task + ".wait") && !existsSync(task + ".release")) await Bun.sleep(5);
 const item = /(?:Start|Continue) at (\\S+) /.exec(text)?.[1];
 appendFileSync("work.txt", (item ?? task) + "\\n");
 const receipt = item ? await tool("kabane_checklistTick", { items: [item] }) : "0/0";
 const [, ticked, total] = /(\\d+)\\/(\\d+)/.exec(receipt);
 if (done === "human") {
  actor = "cabane://actor/human/owner";
  await tool("kabane_done", { id: task });
  actor = AGENT_ACTOR;
 } else if (done === "each" || ticked === total) await tool("kabane_done", { id: task });
 reply(message.id, { stopReason: "end_turn" });
});
`;

const drive = async (
	done: "each" | "last" | "human",
	input: Partial<RunState.Deps> = {},
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
			gemini: {
				command: process.execPath,
				args: [agent, home, join(root, "prompts.jsonl"), done],
			},
		},
		tickMs: 5,
		...input,
	});
	if (!ended.ok) throw ended.error;
	return ended.value;
};

const sent = (): string[] =>
	readFileSync(join(root, "prompts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => String(JSON.parse(line)));

const events = (type: string) => {
	const read = RunStore.readEvents(home, "run-1");
	return read.ok ? read.value.filter((e) => e.type === type) : [];
};

const label = (task: Task): string => task.shortId ?? task.id;

describe("A single-issue run on an issue with a checklist", () => {
	it("works the items in order in one session, each turn pointed at the first open one, and checkpoints them", async () => {
		const issue = await issueWithSteps();
		const id = label(issue);
		await runOn(issue);

		const ended = await drive("last");

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		// One claim, one harness session: the nudges carried it from item to item.
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			[id, "done"],
		]);
		const [opening, ...nudges] = sent();
		expect(opening).toContain(
			`${id} has a checklist of 3 items, 0 ticked, in its brief below`,
		);
		expect(opening).toContain(`Start at ${id}.1 ("Parse the input")`);
		expect(opening).toContain(`## Checklist 0/3`);
		expect(nudges).toEqual([
			expect.stringContaining(
				`${id} is still open, with 2 checklist items not ticked: ${id}.2, ${id}.3. Continue at ${id}.2 ("Validate it")`,
			),
			expect.stringContaining(
				`${id} is still open, with 1 checklist item not ticked: ${id}.3. Continue at ${id}.3 ("Write the output")`,
			),
		]);
		const after = await items(issue);
		expect(after.map((i) => [i.handle, i.done, i.doneBy])).toEqual(
			[1, 2, 3].map((n) => [`${id}.${n}`, true, "cabane://actor/agent/gemini"]),
		);
		const ticks = after.map((i) => i.doneAt ?? "");
		expect(ticks).toEqual(ticks.toSorted());
		const worktree = ended.worktree ?? "";
		expect(readFileSync(join(worktree, "work.txt"), "utf8")).toBe(
			`${id}.1\n${id}.2\n${id}.3\n`,
		);
		// One green pass on the issue's work, so one checkpoint, naming every item it ticked.
		const [checkpoint, ...more] = RunStore.checkpoints(ended);
		expect(more).toEqual([]);
		expect(
			GitFixture.run(worktree, ["show", "-s", "--format=%B", checkpoint ?? ""]),
		).toBe(
			`kabane loop run-1: ${id} stepwise\n\nTicked:\n- ${id}.1 Parse the input\n- ${id}.2 Validate it\n- ${id}.3 Write the output\n\nGates passed: worked.\n\n`,
		);
		expect(events("checkpoint").map((e) => e.data?.ticked)).toEqual([
			`${id}.1, ${id}.2, ${id}.3`,
		]);
	});

	it("refuses done while items are open: reopens the issue and nudges it on from the first open item", async () => {
		const issue = await issueWithSteps();
		const id = label(issue);
		await runOn(issue);

		const ended = await drive("each");

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		const [, ...nudges] = sent();
		expect(nudges).toEqual([
			expect.stringContaining(
				`You called kabane_done on ${id} with 2 checklist items not ticked (${id}.2, ${id}.3), so the run reopened it`,
			),
			expect.stringContaining(
				`You called kabane_done on ${id} with 1 checklist item not ticked (${id}.3), so the run reopened it`,
			),
		]);
		expect(nudges[0]).toContain(`Continue at ${id}.2 ("Validate it")`);
		expect(events("reopened").map((e) => e.summary)).toEqual([
			`${id} reopened: closed with 2 checklist items open`,
			`${id} reopened: closed with 1 checklist item open`,
		]);
		// The gates ran once, on the issue closed with every item ticked.
		expect(ended.gateRuns.filter((r) => r.taskId === issue.id)).toHaveLength(1);
		expect((await items(issue)).every((i) => i.done)).toBe(true);
		const task = await Planner.getTask(home, issue.id);
		expect(task.ok && task.value?.state).toBe("done");
	});

	it("lets a human's close with items open stand: the gates run on it and nothing reopens it", async () => {
		const issue = await issueWithSteps();
		await runOn(issue);

		const ended = await drive("human");

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(ended.claims.map((c) => c.outcome)).toEqual(["done"]);
		expect(sent()).toHaveLength(1);
		expect(events("reopened")).toEqual([]);
		expect(
			ended.gateRuns.filter((r) => r.taskId === issue.id).map((r) => r.ok),
		).toEqual([true]);
		expect((await items(issue)).map((i) => i.done)).toEqual([
			true,
			false,
			false,
		]);
		const task = await Planner.getTask(home, issue.id);
		expect(task.ok && task.value?.state).toBe("done");
	});

	it("ends a session that closed it with items open, once its nudges are spent, and the next claim starts at the first open item", async () => {
		const issue = await issueWithSteps();
		const id = label(issue);
		await runOn(issue);
		const config = RunStore.readRaw(home, "run-1");
		if (!config.ok) throw config.error;
		const written = RunStore.write(home, {
			...config.value,
			config: {
				...config.value.config,
				budget: { ...config.value.config.budget, continuations: 0 },
			},
		});
		if (!written.ok) throw written.error;

		const ended = await drive("each");

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(ended.claims.map((c) => [c.lane, c.outcome, c.detail])).toEqual([
			[
				id,
				"incomplete",
				`turn ended (end_turn) with ${id} closed with 2 checklist items open: reopened`,
			],
			[
				`${id}#2`,
				"incomplete",
				`turn ended (end_turn) with ${id} closed with 1 checklist item open: reopened`,
			],
			[`${id}#3`, "done", `${id} is done`],
		]);
		const openings = sent();
		expect(openings).toHaveLength(3);
		expect(openings[1]).toContain(`1 ticked, in its brief below`);
		expect(openings[1]).toContain(`Start at ${id}.2 ("Validate it")`);
		expect(openings[2]).toContain(`Start at ${id}.3 ("Write the output")`);
	});
});

describe("A single-issue run resumed after its runner died mid-checklist", () => {
	it("hands the next session the first open item, leaving the ticked one as it was", async () => {
		const issue = await issueWithSteps();
		const id = label(issue);
		const [first] = await items(issue);
		const ticked = await Checklist.tick(
			home,
			{ items: [first?.id ?? ""] },
			"cabane://actor/agent/gemini",
		);
		if (!ticked.ok) throw ticked.error;
		const held = await Planner.updateTask(home, issue.id, {
			state: "in_progress",
			assignee: "gemini",
		});
		if (!held.ok) throw held.error;
		const session = await Planner.startSession(home, {
			taskId: issue.id,
			agent: "gemini",
			externalRef: RunStore.sessionRef("run-1"),
		});
		if (!session.ok) throw session.error;
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		await runOn(issue, {
			status: "running",
			pid: Bun.spawnSync(["true"]).pid,
			startedAt,
			claims: [
				{
					taskId: issue.id,
					shortId: id,
					harness: "gemini",
					lane: id,
					sessionId: session.value.id,
					startedAt,
					continuations: 0,
				},
			],
		});

		const ended = await drive("last");

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			[id, "interrupted"],
			[`${id}#2`, "done"],
		]);
		const [takeover] = sent();
		expect(takeover).toContain("which was interrupted");
		expect(takeover).toContain(
			`${id} has a checklist of 3 items, 1 ticked, in its brief below`,
		);
		expect(takeover).toContain(`Start at ${id}.2 ("Validate it")`);
		const after = await items(issue);
		expect(after.map((i) => i.done)).toEqual([true, true, true]);
		expect(after[0]?.doneAt).toBe(ticked.value.items[0]?.doneAt);
		const worktree = ended.worktree ?? "";
		expect(readFileSync(join(worktree, "work.txt"), "utf8")).toBe(
			`${id}.2\n${id}.3\n`,
		);
		// The run's checkpoint names what it ticked since it started, the dead runner's tick too.
		expect(events("checkpoint").map((e) => e.data?.ticked)).toEqual([
			`${id}.1, ${id}.2, ${id}.3`,
		]);
	});
});

describe("A checkpoint on a task with a checklist", () => {
	it("names only the items ticked since the task's last checkpoint", async () => {
		const issue = await issueWithSteps();
		const id = label(issue);
		const run = await runOn(issue, { startedAt: new Date().toISOString() });
		const log = RunStore.eventLog(home, run.id);
		if (!log.ok) throw log.error;
		const ctx = RunState.make(
			{
				home,
				basePath: home,
				kabaneBin: "/nonexistent/kabane",
				pid: process.pid,
				git,
			},
			run,
			log.value,
		);
		const worktree = run.worktree ?? "";
		const subject = { taskId: issue.id, label: id, title: "stepwise" };
		// One item ticked and its work written, then a pass; then the next, and another.
		const pass = async (n: number) => {
			const ticked = await Checklist.tick(home, { items: [`${id}.${n}`] });
			if (!ticked.ok) throw ticked.error;
			writeFileSync(join(worktree, "work.txt"), `${id}.${n}\n`);
			const checked = await Checks.gate(ctx, subject);
			return GitFixture.run(worktree, [
				"show",
				"-s",
				"--format=%B",
				checked.checkpoint ?? "",
			]);
		};

		expect(await pass(1)).toContain(`Ticked:\n- ${id}.1 Parse the input\n\n`);
		expect(await pass(2)).toContain(`Ticked:\n- ${id}.2 Validate it\n\n`);
	});
});

describe("Checklists.refuseDone", () => {
	const AGENT = "cabane://actor/agent/gemini";

	// `kind`, closed by the session's own actor with its checklist's items all open.
	const closedBySession = async (kind: Task["kind"]): Promise<Task> => {
		configureTestRuntime("", {
			modules: [checklistModule],
			actor: () => AGENT,
		});
		const created = await Planner.addTask(home, {
			title: kind,
			kind,
			state: "next",
			assignee: "gemini",
		});
		if (!created.ok) throw created.error;
		const added = await Checklist.add(home, {
			id: created.value.id,
			items: STEPS,
		});
		if (!added.ok) throw added.error;
		const closed = await Planner.updateTask(home, created.value.id, {
			state: "done",
		});
		if (!closed.ok || !closed.value) throw new Error("not closed");
		return closed.value;
	};

	it("reopens an issue its session closed with items open", async () => {
		const issue = await closedBySession("issue");
		const refused = await Checklists.refuseDone(home, issue, "gemini");
		expect(refused.ok && refused.value.length).toBe(3);
		const after = await Planner.getTask(home, issue.id);
		expect(after.ok && after.value?.state).toBe("in_progress");
	});

	it("never reopens a personal task", async () => {
		const task = await closedBySession("task");
		const refused = await Checklists.refuseDone(home, task, "gemini");
		expect(refused.ok && refused.value).toEqual([]);
		const after = await Planner.getTask(home, task.id);
		expect(after.ok && after.value?.state).toBe("done");
	});
});

describe("A parent run with two sessions at once", () => {
	const until = async (predicate: () => Promise<boolean>): Promise<void> => {
		const deadline = Date.now() + 5_000;
		while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(5);
		expect(await predicate()).toBe(true);
	};

	it("holds back a pass queued behind another when an item was added while it waited", async () => {
		const parent = await Planner.addTask(home, {
			title: "parent",
			kind: "issue",
			state: "next",
		});
		if (!parent.ok) throw parent.error;
		const subtask = async (title: string) => {
			const created = await Planner.addTask(home, {
				title,
				kind: "issue",
				state: "next",
				parentTaskId: parent.value.id,
			});
			if (!created.ok) throw created.error;
			return created.value;
		};
		const first = await subtask("first");
		const second = await subtask("second");
		const steps = await Checklist.add(home, {
			id: second.id,
			items: ["The one step"],
		});
		if (!steps.ok) throw steps.error;
		// The first subtask's pass holds on `hold` while the second's session ends and queues behind it.
		const run = await runOn(
			parent.value,
			{},
			{
				gates: { held: "while [ -f hold ]; do sleep 0.01; done" },
				budget: { concurrency: 2 },
			},
		);
		const worktree = run.worktree ?? "";
		const b = label(second);
		writeFileSync(join(worktree, "hold"), "");
		writeFileSync(join(worktree, `${b}.wait`), "");

		const running = drive("last");
		await until(async () =>
			events("gates").some((e) => e.task === label(first)),
		);
		writeFileSync(join(worktree, `${b}.release`), "");
		await until(async () => {
			const task = await Planner.getTask(home, second.id);
			return task.ok && task.value?.state === "done";
		});
		// Its session ends and its pass queues behind the first's, which still holds.
		await Bun.sleep(300);
		const late = await Checklist.add(home, {
			id: second.id,
			items: ["A step added while its pass waited"],
		});
		if (!late.ok) throw late.error;
		rmSync(join(worktree, "hold"));
		const ended = await running;

		expect([ended.status, ended.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(events("reopened").map((e) => e.summary)).toEqual([
			`${b} reopened: closed with 1 checklist item open`,
		]);
		expect(ended.claims.map((c) => c.lane)).toContain(`${b}#2`);
		expect((await items(second)).map((i) => i.done)).toEqual([true, true]);
	});
});
