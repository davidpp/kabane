import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type TaskDraft } from "@cabane/core";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-steering-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const add = async (draft: Partial<TaskDraft> & { title: string }) => {
	const created = await Planner.addTask(home, {
		kind: "issue",
		state: "next",
		...draft,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const load = async (parentId: string): Promise<LoopPlan.Plan> => {
	const plan = await LoopPlan.load(home, parentId);
	if (!plan.ok) throw plan.error;
	return plan.value;
};

const titles = (nodes: LoopPlan.Node[]): string[] =>
	nodes.map((n) => n.task.title);

const AT = "2026-10-11T00:00:00.000Z";
const NOW = new Date(AT);
const NONE = new Set<string>();

// A pending run on `parent`, as `Loop.start` writes it, with the runner's pid when it is live.
const runOn = (
	parent: { id: string; shortId?: string },
	extra: Partial<RunStore.Run> = {},
): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({
		budget: { concurrency: 1 },
	});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: home,
		config: config.data,
		status: "pending",
		createdAt: AT,
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
		...extra,
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	return run;
};

describe("Steering.apply", () => {
	it("folds pause, resume, skip and next into what the run claims", () => {
		const skip = { kind: "skip", at: AT, taskId: "t1", task: "K-2" } as const;
		const next = { kind: "next", at: AT, taskId: "t1", task: "K-2" } as const;
		let state = Steering.apply(Steering.INITIAL, {
			kind: "pause",
			at: AT,
		}).state;
		expect(state.paused).toBe(true);
		state = Steering.apply(state, { kind: "resume", at: AT }).state;
		expect(state.paused).toBe(false);

		state = Steering.apply(state, next).state;
		expect(state).toEqual({ paused: false, skipped: [], next: ["t1"] });
		// Skipping what was asked for first takes it off the next list.
		state = Steering.apply(state, skip).state;
		expect(state).toEqual({ paused: false, skipped: ["t1"], next: [] });
		// Asking for a skipped subtask first is asking for it again.
		state = Steering.apply(state, next).state;
		expect(state).toEqual({ paused: false, skipped: [], next: ["t1"] });
		expect(Steering.claimed(state, "t1")).toEqual(Steering.INITIAL);
	});
});

describe("Steering claim decisions", () => {
	it("skip: the subtask is never claimed and what it blocks stays blocked", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent.id });
		const b = await add({ title: "b", parentTaskId: parent.id });
		const c = await add({ title: "c", parentTaskId: parent.id });
		const linked = await Planner.addLink(home, {
			sourceId: a.id,
			targetId: c.id,
			type: "blocks",
		});
		if (!linked.ok) throw linked.error;
		const skipped = new Set([a.id]);
		const plan = await load(parent.id);

		expect(titles(LoopPlan.frontier(plan, NONE, NOW, skipped))).toEqual(["b"]);
		await Planner.updateTask(home, b.id, { state: "done" });
		expect(LoopPlan.health(await load(parent.id), NONE, NOW, skipped)).toEqual({
			kind: "waiting",
			on: [{ id: a.shortId ?? a.id, why: "skipped", parked: false }],
		});
	});

	it("next: the asked subtask is claimed first, ahead of priority, once ready", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "urgent", parentTaskId: parent.id, priority: "urgent" });
		const low = await add({
			title: "low",
			parentTaskId: parent.id,
			priority: "low",
		});
		const ready = LoopPlan.frontier(await load(parent.id), NONE, NOW);
		const state = { ...Steering.INITIAL, next: [low.id] };
		expect(titles(Steering.pick(state, ready, 1))).toEqual(["low"]);
		expect(titles(Steering.pick(Steering.INITIAL, ready, 1))).toEqual([
			"urgent",
		]);
	});

	it("pause: nothing is claimed, whatever is ready", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "a", parentTaskId: parent.id });
		const ready = LoopPlan.frontier(await load(parent.id), NONE, NOW);
		expect(
			Steering.pick({ ...Steering.INITIAL, paused: true }, ready, 2),
		).toEqual([]);
	});
});

describe("Loop.pause and Loop.direct", () => {
	it("write directives to the inbox of the live run on the subtask's parent", async () => {
		const parent = await add({ title: "parent" });
		const child = await add({ title: "child", parentTaskId: parent.id });
		const other = await add({ title: "elsewhere" });
		runOn(parent, { status: "running", pid: process.pid });

		expect(Loop.pause({ home }, "run-1", "pause").ok).toBe(true);
		const skipped = await Loop.direct(
			{ home, basePath: home },
			"skip",
			child.shortId ?? child.id,
		);
		expect(skipped.ok && skipped.value).toEqual({
			runId: "run-1",
			task: child.shortId ?? child.id,
		});
		const stray = await Loop.direct(
			{ home, basePath: home },
			"next",
			other.id,
			"run-1",
		);
		expect(!stray.ok && stray.error.message).toContain("not a subtask");

		const inbox = RunStore.readInbox(home, "run-1", 0);
		expect(inbox.ok && inbox.value.entries).toEqual([
			{ kind: "pause", at: expect.any(String) },
			{
				kind: "skip",
				at: expect.any(String),
				taskId: child.id,
				task: child.shortId ?? "",
			},
		]);
	});

	it("steer a single issue in the run on it, and name the issue when no run has it", async () => {
		const issue = await add({ title: "issue" });
		const short = issue.shortId ?? issue.id;
		const deps = { home, basePath: home };
		const none = await Loop.direct(deps, "skip", short);
		expect(!none.ok && none.error.message).toBe(
			`No live loop run is working on ${short}`,
		);

		runOn(issue, { status: "running", pid: process.pid });
		const skipped = await Loop.direct(deps, "skip", short);
		expect(skipped.ok && skipped.value).toEqual({
			runId: "run-1",
			task: short,
		});
		expect((await Loop.direct(deps, "next", short, "run-1")).ok).toBe(true);
		const stray = await add({ title: "elsewhere" });
		const refused = await Loop.direct(deps, "skip", stray.id, "run-1");
		expect(!refused.ok && refused.error.message).toBe(
			`${stray.shortId} is not ${short}, the single issue run run-1 works`,
		);

		// Once a child makes it a parent, the run works the child and the issue is not claimed.
		await add({ title: "child", parentTaskId: issue.id });
		const parent = await Loop.direct(deps, "skip", short);
		expect(!parent.ok && parent.error.message).toBe(
			`${short} is the parent run run-1 works the subtasks of: skip or next one of them`,
		);
	});

	it("refuse a run that is over", async () => {
		const parent = await add({ title: "parent" });
		runOn(parent, { status: "completed" });
		const asked = Loop.pause({ home }, "run-1", "resume");
		expect(!asked.ok && asked.error.message).toBe("Run run-1 is completed");
	});
});

describe("Runner inbox handling", () => {
	// The real runner on a real plan whose one subtask the human skipped before it booted: it
	// reads the directive, claims nothing and says why it waits. A wrong claim would fail at the
	// launch, which points at no harness, rather than reach one.
	it("a skipped subtask is never claimed and the run says what it waits on", async () => {
		const parent = await add({ title: "parent" });
		const child = await add({ title: "child", parentTaskId: parent.id });
		runOn(parent);
		RunStore.appendInbox(home, "run-1", {
			kind: "skip",
			at: AT,
			taskId: child.id,
			task: child.shortId ?? child.id,
		});
		const controller = new AbortController();
		const running = Runner.run("run-1", {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			signal: controller.signal,
			overrides: { claude: { command: "/nonexistent/harness" } },
			tree: async () => "tree",
			tickMs: 5,
		});
		const waited = async (): Promise<RunStore.Event[]> => {
			for (let i = 0; i < 200; i++) {
				const events = RunStore.readEvents(home, "run-1");
				if (events.ok && events.value.some((e) => e.type === "waiting"))
					return events.value;
				await Bun.sleep(5);
			}
			return [];
		};
		const events = await waited();
		controller.abort();
		const ended = await running;

		expect(events.map((e) => [e.type, e.summary])).toContainEqual([
			"waiting",
			`waiting on ${child.shortId} (skipped)`,
		]);
		expect(events.some((e) => e.type === "skipped")).toBe(true);
		expect(ended.ok && ended.value.claims).toEqual([]);
		expect(ended.ok && ended.value.steering.skipped).toEqual([child.id]);
	});
});
