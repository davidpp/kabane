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
		const events = RunStore.readEvents(home, "run-1");
		expect(events.ok && events.value.some((e) => e.type === "waiting")).toBe(
			true,
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
