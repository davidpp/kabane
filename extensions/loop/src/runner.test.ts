import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// The real runner resuming a run whose runner died, on a real tracker. The run is paused, so it
// claims nothing and no harness is reached; a wrong claim would fail at the launch, which points
// at no harness.
import "@kabane/core/testing";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@kabane/core";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { TestHarnesses } from "./test-harnesses";
import { testHost } from "./test-host";

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
	host: testHost(home),
	kabaneBin: () => "/nonexistent/kabane",
	pid: process.pid,
	overrides: TestHarnesses.overrides({
		claude: { command: "/nonexistent/harness" },
	}),
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

// A harness that never answers ACP `initialize`, as an adapter stuck in an npx download or an
// auth prompt would be: a real child, so the test can see whether the stop leaves it running.
describe("Runner stop during a session's handshake", () => {
	const alive = (pid: number): boolean => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	it("kills the harness it launched and ends the claim as cancelled", async () => {
		await orphaned("run-1", { steering: Steering.INITIAL });
		const pidfile = join(home, "harness.pid");
		const controller = new AbortController();
		const running = Runner.run("run-1", {
			...deps(controller.signal),
			overrides: TestHarnesses.overrides({
				claude: {
					command: "sh",
					args: ["-c", 'echo $$ > "$0"; exec sleep 600', pidfile],
				},
			}),
		});
		// sh creates the file before echo fills it: an empty read would be pid 0, always alive.
		const written = () =>
			existsSync(pidfile) ? readFileSync(pidfile, "utf8").trim() : "";
		for (let i = 0; i < 400 && !written(); i++) await Bun.sleep(5);
		const pid = Number(written());
		expect(alive(pid)).toBe(true);

		controller.abort();
		const ended = await running;
		if (!ended.ok) throw ended.error;

		// The kill is sent before the run returns; the exit lands a moment later. Without it the
		// child would live until the 30 s handshake cap, long after the runner had gone.
		for (let i = 0; i < 200 && alive(pid); i++) await Bun.sleep(5);
		expect(alive(pid)).toBe(false);
		expect(ended.value.exit?.reason).toBe("stop-requested");
		expect(ended.value.claims.map((c) => c.outcome)).toEqual(["cancelled"]);
	});
});

// A harness in the middle of a turn it never ends, that ignores `session/cancel`, stdin EOF and
// SIGTERM, with a child that ignores SIGTERM too (`packages/acp/scripts/stubborn-agent.ts`): only
// the fallback kill of its process group, after the runner's cancel grace, stops them, and the
// detached runner exits as soon as the run returns.
describe("Runner stop during a turn on a harness that will not stop", () => {
	// Gone, or a zombie its new parent has yet to reap: either way it runs nothing.
	const running = (pid: number): boolean => {
		const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
			.stdout.toString()
			.trim();
		return stat !== "" && !stat.startsWith("Z");
	};

	const left: number[] = [];
	afterEach(() => {
		for (const pid of left.splice(0))
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
	});

	// The runner's 10 s cancel grace, the 2 s stdin EOF grace, the sweep, and room to spare.
	it("returns only once the harness and the child it started have exited", async () => {
		await orphaned("run-1", { steering: Steering.INITIAL });
		const pidfile = join(home, "harness.pids");
		const controller = new AbortController();
		const ran = Runner.run("run-1", {
			...deps(controller.signal),
			overrides: TestHarnesses.overrides({
				claude: {
					command: process.execPath,
					args: [
						join(
							import.meta.dir,
							"../../../packages/acp/scripts/stubborn-agent.ts",
						),
						pidfile,
						"turn",
					],
				},
			}),
		});
		// Written once the first prompt has arrived, which the harness never answers.
		for (let i = 0; i < 1000 && !existsSync(pidfile); i++) await Bun.sleep(5);
		const pids = readFileSync(pidfile, "utf8").split(" ").map(Number);
		left.push(...pids);
		expect(pids.map(running)).toEqual([true, true]);

		controller.abort();
		const ended = await ran;
		if (!ended.ok) throw ended.error;

		expect(pids.map(running)).toEqual([false, false]);
		expect(ended.value.exit?.reason).toBe("stop-requested");
	}, 30_000);
});

describe("Runner resume on a single issue", () => {
	it("releases the issue its dead runner's claim held, and does not take it as a parent", async () => {
		const issue = await add("lone");
		const held = await Planner.updateTask(home, issue.id, {
			state: "in_progress",
			assignee: "claude",
		});
		if (!held.ok) throw held.error;
		const sessionId = RunStore.newSessionId();
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
					sessionId: sessionId,
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
		const sessionId = RunStore.newSessionId();
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
					sessionId: sessionId,
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
