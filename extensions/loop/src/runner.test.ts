// The real runner resuming a run whose runner died, on a real tracker. The run is paused, so it
// claims nothing and no harness is reached; a wrong claim would fail at the launch, which points
// at no harness.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@cabane/core";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-runner-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const HOUR = 3_600_000;

// A pid that existed and is gone: the exited child of a real spawn.
const deadPid = (): number => Bun.spawnSync(["true"]).pid;

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

// A paused run on a parent with one open subtask, whose runner died: what `kabane loop run <id>`
// picks up again.
const orphaned = async (
	id: string,
	extra: Partial<RunStore.Run> = {},
): Promise<RunStore.Run> => {
	const parent = await add(`parent of ${id}`);
	await add("child", parent.id);
	const config = LoopConfig.Schema.safeParse({});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id,
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: home,
		config: config.data,
		status: "running",
		pid: deadPid(),
		createdAt: new Date(Date.now() - 3 * HOUR).toISOString(),
		startedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: { ...Steering.INITIAL, paused: true },
		gateRuns: [],
		...extra,
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	return run;
};

const deps = (signal?: AbortSignal) => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent/kabane",
	pid: process.pid,
	overrides: { claude: { command: "/nonexistent/harness" } },
	tree: async () => "tree",
	tickMs: 5,
	...(signal ? { signal } : {}),
});

// Drive run `id` until it says it is waiting, then stop it; what it ended as.
const resumeUntilWaiting = async (id: string): Promise<RunStore.Run> => {
	const controller = new AbortController();
	const running = Runner.run(id, deps(controller.signal));
	for (let i = 0; i < 400; i++) {
		const events = RunStore.readEvents(home, id);
		if (events.ok && events.value.some((e) => e.type === "waiting")) break;
		await Bun.sleep(5);
	}
	controller.abort();
	const ended = await running;
	if (!ended.ok) throw ended.error;
	return ended.value;
};

describe("Runner resume", () => {
	it("keeps running beyond the former two-hour deadline until explicitly stopped", async () => {
		const legacy = await orphaned("run-1");
		writeFileSync(
			RunStore.paths(home, legacy.id).run,
			JSON.stringify({
				...legacy,
				config: {
					...legacy.config,
					budget: { ...legacy.config.budget, wallMinutes: 120 },
				},
				clock: { spentMs: 3 * HOUR, at: legacy.startedAt },
			}),
		);
		const ended = await resumeUntilWaiting("run-1");
		expect(ended.exit?.reason).toBe("stop-requested");
		// The resumed runner's identity replaces the dead one's: its pid and when it started.
		const start = RunStore.processStart(process.pid);
		expect([ended.pid, ended.pidStart]).toEqual([
			process.pid,
			start.ok ? start.value : "unreadable",
		]);
		const events = RunStore.readEvents(home, "run-1");
		expect(events.ok && events.value.some((e) => e.type === "waiting")).toBe(
			true,
		);
	});

	it("says a parked subtask holds it and how a human releases it, and drops a dead runner's pass", async () => {
		const run = await orphaned("run-1", {
			steering: Steering.INITIAL,
			gating: ["KAB-9"],
		});
		const children = await Planner.queryTasks(home, {
			parentTaskId: run.parentId,
		});
		const child = children.ok ? children.value[0] : undefined;
		if (!child) throw new Error("no child");
		await Planner.updateTask(home, child.id, { state: "someday" });
		const ended = await resumeUntilWaiting("run-1");
		expect(ended.gating).toBeUndefined();
		const events = RunStore.readEvents(home, "run-1");
		const short = child.shortId ?? child.id;
		expect(
			events.ok && events.value.find((e) => e.type === "waiting")?.summary,
		).toBe(
			`waiting on ${short} (someday); only a human releases it: \`kabane edit ${short} --state next\` hands it to the run, or close it in the tracker`,
		);
	});

	it("refuses to resume while another live run has its parent", async () => {
		const dead = await orphaned("run-1");
		RunStore.create(home, {
			...dead,
			id: "run-2",
			pid: process.pid,
			createdAt: new Date().toISOString(),
		});

		const resumed = await Runner.run("run-1", deps());

		expect(!resumed.ok && resumed.error.message).toBe(
			`Run run-1 cannot resume: ${dead.parentShortId} already has a live loop run, run-2; stop it first`,
		);
		const untouched = RunStore.readRaw(home, "run-1");
		expect(untouched.ok && untouched.value.pid).toBe(dead.pid);
	});
});

describe("Runner resume on a single issue", () => {
	it("releases the issue its dead runner's claim held, and does not take it as a parent", async () => {
		const issue = await add("lone");
		const held = await Planner.updateTask(home, issue.id, {
			state: "in_progress",
			assignee: "claude",
		});
		if (!held.ok) throw held.error;
		const session = await Planner.startSession(home, {
			taskId: issue.id,
			agent: "claude",
		});
		if (!session.ok) throw session.error;
		const dead = await orphaned("run-1");
		const run: RunStore.Run = {
			...dead,
			parentId: issue.id,
			parentShortId: issue.shortId ?? issue.id,
			claims: [
				{
					taskId: issue.id,
					shortId: issue.shortId ?? issue.id,
					harness: "claude",
					lane: issue.shortId ?? issue.id,
					sessionId: session.value.id,
					startedAt: new Date(Date.now() - HOUR).toISOString(),
					continuations: 0,
				},
			],
		};
		const written = RunStore.write(home, run);
		if (!written.ok) throw written.error;

		const ended = await resumeUntilWaiting("run-1");

		expect(ended.claims.map((c) => c.outcome)).toEqual(["interrupted"]);
		const after = await Planner.getTask(home, issue.id);
		expect(after.ok && after.value?.state).toBe("next");
		const logs = await Planner.getWorkLogs(home, issue.id);
		expect(
			logs.ok && logs.value.flatMap((l) => l.refs.map((r) => r.uri)),
		).not.toContain("loop:run-1");
	});
});

describe("Runner resume on a single issue that has become a parent", () => {
	// The issue, a child a human added under it, and the dead run's claim on the issue itself.
	const reshaped = async (
		state: Task["state"],
		claim: Partial<RunStore.Claim>,
		extra: Partial<RunStore.Run> = {},
	): Promise<Task> => {
		const issue = await add("lone");
		const set = await Planner.updateTask(home, issue.id, {
			state,
			assignee: "claude",
		});
		if (!set.ok) throw set.error;
		await add("split off", issue.id);
		const session = await Planner.startSession(home, {
			taskId: issue.id,
			agent: "claude",
		});
		if (!session.ok) throw session.error;
		const dead = await orphaned("run-1");
		const written = RunStore.write(home, {
			...dead,
			parentId: issue.id,
			parentShortId: issue.shortId ?? issue.id,
			claims: [
				{
					taskId: issue.id,
					shortId: issue.shortId ?? issue.id,
					harness: "claude",
					lane: issue.shortId ?? issue.id,
					sessionId: session.value.id,
					startedAt: new Date(Date.now() - HOUR).toISOString(),
					continuations: 0,
					...claim,
				},
			],
			...extra,
		});
		if (!written.ok) throw written.error;
		return issue;
	};

	it("leaves a state a human gave the issue", async () => {
		const ended = new Date(Date.now() - HOUR / 2).toISOString();
		const issue = await reshaped("waiting", {
			endedAt: ended,
			outcome: "done",
		});
		await resumeUntilWaiting("run-1");
		const after = await Planner.getTask(home, issue.id);
		expect(after.ok && after.value?.state).toBe("waiting");
	});

	it("finishes the gate pass its dead session owed before taking it as a parent", async () => {
		const config = LoopConfig.Schema.safeParse({ gates: { ok: "true" } });
		if (!config.success) throw config.error;
		const issue = await reshaped("done", {}, { config: config.data });
		const resumed = await resumeUntilWaiting("run-1");
		expect(resumed.gateRuns.map((g) => g.taskId)).toEqual([issue.id]);
		const after = await Planner.getTask(home, issue.id);
		expect(after.ok && after.value?.state).toBe("in_progress");
	});
});
