// The parent's state across a run, driven by the real runner on a real tracker. Every run here is
// paused or has nothing to claim, so no harness is reached.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task, type TaskDraft } from "@cabane/core";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-parent-"));
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

const createRun = (parent: Task, paused: boolean): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: home,
		config: config.data,
		status: "pending",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: { ...Steering.INITIAL, paused },
		gateRuns: [],
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

const get = async (id: string): Promise<Task> => {
	const task = await Planner.getTask(home, id);
	if (!task.ok || !task.value) throw new Error(`${id} not read`);
	return task.value;
};

const comments = async (id: string): Promise<string[]> => {
	const read = await Planner.getComments(home, id);
	if (!read.ok) throw read.error;
	return read.value.map((c) => c.content);
};

const until = async (predicate: () => boolean): Promise<void> => {
	const deadline = Date.now() + 3_000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
};

const waiting = (): boolean => {
	const events = RunStore.readEvents(home, "run-1");
	return events.ok && events.value.some((e) => e.type === "waiting");
};

// Start a paused run on `parent`, let `during` act while it waits, then stop it unless it ends.
const drive = async (
	parent: Task,
	during: () => Promise<void> = async () => {},
): Promise<RunStore.Run> => {
	createRun(parent, true);
	const controller = new AbortController();
	const running = Runner.run("run-1", deps(controller.signal));
	await until(waiting);
	await during();
	const ended = await Promise.race([
		running,
		Bun.sleep(200).then(() => {
			controller.abort();
			return running;
		}),
	]);
	if (!ended.ok) throw ended.error;
	return ended.value;
};

describe("Parent state across a run", () => {
	for (const state of ["next", "inbox", "waiting", "done"] as const)
		it(`moves a ${state} parent to in_progress on start, logging the run`, async () => {
			const parent = await add({ title: "parent", state });
			await add({ title: "child", parentTaskId: parent.id });
			let during: Task | undefined;
			await drive(parent, async () => {
				during = await get(parent.id);
			});
			expect(during?.state).toBe("in_progress");
			const logs = await Planner.getWorkLogs(home, parent.id);
			expect(logs.ok && logs.value.flatMap((l) => l.refs)).toMatchObject([
				{ uri: "loop:run-1", label: "loop run started", addedBy: "loop:run-1" },
			]);
		});

	it("leaves an in_progress or someday parent's state alone", async () => {
		for (const state of ["in_progress", "someday"] as const) {
			rmSync(home, { recursive: true, force: true });
			home = mkdtempSync(join(tmpdir(), "loop-parent-"));
			await Planner.init(home);
			const parent = await add({ title: "parent", state });
			await add({ title: "child", parentTaskId: parent.id });
			let during: Task | undefined;
			await drive(parent, async () => {
				during = await get(parent.id);
			});
			expect([during?.state, during?.version]).toEqual([state, 1]);
		}
	});

	it("keeps a completed run's parent in_progress, flags it for review and summarises the run", async () => {
		const parent = await add({ title: "parent" });
		const child = await add({ title: "child", parentTaskId: parent.id });
		const fixed = await add({
			title: "fixed finding",
			state: "done",
			tags: ["finding", "p2", "security"],
			parentTaskId: parent.id,
		});
		// Parked by a human, so the fixer does not take it: it stays open for the human.
		const open = await add({
			title: "open finding",
			state: "waiting",
			tags: ["finding", "p3", "security"],
			parentTaskId: parent.id,
		});
		const ended = await drive(parent, async () => {
			const closed = await Planner.updateTask(home, child.id, {
				state: "done",
			});
			if (!closed.ok) throw closed.error;
		});
		expect(ended.exit?.reason).toBe("plan-done");
		const after = await get(parent.id);
		expect([after.state, after.needsReview]).toEqual(["in_progress", true]);
		expect(await comments(parent.id)).toEqual([
			[
				"Loop run run-1 completed (plan-done).",
				"",
				"- Subtasks done: 1 of 1",
				`- Findings fixed: ${fixed.shortId}`,
				`- Findings left open for you: ${open.shortId}`,
				"",
				`The changes are in the working tree of \`${home}\`.`,
			].join("\n"),
		]);
	});

	it("keeps a stopped run's parent in_progress and says how to go on", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "child", parentTaskId: parent.id });
		const ended = await drive(parent);
		expect(ended.exit?.reason).toBe("stop-requested");
		const after = await get(parent.id);
		expect([after.state, after.needsReview]).toEqual(["in_progress", false]);
		expect(await comments(parent.id)).toEqual([
			`Loop run run-1 stopped: stop-requested.\n\nNext: \`kabane loop start ${parent.shortId}\` starts a new run.`,
		]);
	});

	for (const state of ["waiting", "done"] as const)
		it(`keeps a parent a human moved to ${state} during the run, only commenting`, async () => {
			const parent = await add({ title: "parent" });
			const child = await add({ title: "child", parentTaskId: parent.id });
			const ended = await drive(parent, async () => {
				const moved = await Planner.updateTask(home, parent.id, { state });
				if (!moved.ok) throw moved.error;
				const closed = await Planner.updateTask(home, child.id, {
					state: "done",
				});
				if (!closed.ok) throw closed.error;
			});
			expect(ended.exit?.reason).toBe("plan-done");
			const after = await get(parent.id);
			expect([after.state, after.needsReview]).toEqual([state, false]);
			expect(await comments(parent.id)).toHaveLength(1);
		});
});

describe("A single issue across a run", () => {
	it("is not taken on start: its state is the claim's to change", async () => {
		const issue = await add({ title: "lone" });
		let during: Task | undefined;
		const ended = await drive(issue, async () => {
			during = await get(issue.id);
		});
		expect([during?.state, during?.version]).toEqual(["next", 1]);
		const logs = await Planner.getWorkLogs(home, issue.id);
		expect(logs.ok && logs.value).toEqual([]);
		expect(ended.exit?.reason).toBe("stop-requested");
		expect(await comments(issue.id)).toEqual([
			`Loop run run-1 stopped: stop-requested.\n\nNext: \`kabane loop start ${issue.shortId}\` starts a new run.`,
		]);
	});

	it("completes once its session closes it, flagged for the merge, with no subtask count", async () => {
		const issue = await add({ title: "lone" });
		const ended = await drive(issue, async () => {
			const closed = await Planner.updateTask(home, issue.id, {
				state: "done",
			});
			if (!closed.ok) throw closed.error;
		});
		expect(ended.exit?.reason).toBe("plan-done");
		const after = await get(issue.id);
		expect([after.state, after.needsReview]).toEqual(["done", true]);
		expect(await comments(issue.id)).toEqual([
			[
				"Loop run run-1 completed (plan-done).",
				"",
				"- Findings fixed: none",
				"- Findings left open for you: none",
				"",
				`The changes are in the working tree of \`${home}\`.`,
			].join("\n"),
		]);
	});
});
