import { describe, expect, test } from "bun:test";
import type { Task } from "@cabane/core";
import type { JobFacts } from "@cabane/extension";
import { BoardJobs } from "./jobs";
import { BoardNav } from "./nav";
import { BoardTabs } from "./tabs";

const job = (id: string, over: Partial<Task> = {}): Task => ({
	id,
	shortId: id.toUpperCase(),
	title: `Job ${id}`,
	kind: "job",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-11-16T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	scopeUri: "kabane://scope/second-brain",
	createdAt: "2026-11-16T00:00:00.000Z",
	updatedAt: "2026-11-16T00:00:00.000Z",
	...over,
});

const NOW = Date.parse("2026-11-17T06:00:00.000Z");

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({
	schedule: "0 9 * * *",
	next: "2026-11-17T09:00:00.000Z",
	recipe: "wiki-maintenance",
	inputs: {},
	harness: ["claude"],
	session: "fresh",
	runs: [],
	...over,
});

const waitingRun = {
	id: "run-1",
	state: "waiting" as const,
	startedAt: "2026-11-17T05:00:00.000Z",
	open: "kabane runs attach run-1",
};

describe("BoardJobs", () => {
	test("groups the rows by scope and keeps the selected one across a poll", () => {
		const list = [
			{ task: job("a") },
			{ task: job("b", { scopeUri: "kabane://scope/kabane" }) },
			{ task: job("c") },
		];
		const first = BoardJobs.withList(BoardJobs.NONE, list);
		expect(first.list.map((one) => one.task.id)).toEqual(["a", "c", "b"]);
		expect(first.selectedId).toBe("a");
		const moved = BoardJobs.move(first, 1);
		expect(moved.selectedId).toBe("c");
		expect(BoardJobs.withList(moved, list)).toBe(moved);
		expect(BoardJobs.withList(moved, [{ task: job("b") }]).selectedId).toBe(
			"b",
		);
	});

	test("a bay is named after its jobs' folder on this machine, else the scope's id", () => {
		const groups = BoardJobs.byScope([
			{
				task: job("a"),
				facts: facts({ folder: "/Users/d/Vaults/second-brain" }),
			},
			{ task: job("b", { scopeUri: "kabane://scope/kabane" }) },
		]);
		expect(groups.map((group) => group.scope)).toEqual([
			"second-brain",
			"kabane",
		]);
	});

	test("a row leads with a waiting run, then paused, then the next fire and what it runs", () => {
		const waiting = { task: job("a"), facts: facts({ runs: [waitingRun] }) };
		expect(BoardJobs.meta(waiting, NOW)).toEqual([
			"? waiting",
			"in 3h",
			"0 9 * * *",
			"wiki-maintenance",
			"claude",
		]);
		expect(
			BoardJobs.meta(
				{ task: job("b", { state: "someday" }), facts: facts() },
				NOW,
			),
		).toEqual(["paused", "0 9 * * *", "wiki-maintenance", "claude"]);
		// No source: the item alone.
		expect(BoardJobs.meta({ task: job("c") }, NOW)).toEqual([]);
		expect(BoardJobs.waitingCount({ list: [waiting], selectedId: "a" })).toBe(
			1,
		);
	});

	test("a narrow row keeps the meta that fits, from the front", () => {
		expect(
			BoardJobs.fitMeta(
				["? waiting", "in 3h", "0 9 * * *", "wiki-maintenance"],
				22,
			),
		).toEqual(["? waiting", "in 3h"]);
	});
});

describe("the Jobs tab", () => {
	const base = BoardNav.init([], { scoped: false });
	const withTwo = BoardTabs.withJobs(base, [
		{ task: job("a") },
		{ task: job("b"), facts: facts({ runs: [waitingRun] }) },
	]);
	const key = (state: BoardNav.BoardState, name: string) =>
		BoardNav.reduceKey(
			state,
			{ name, sequence: name },
			Number.MAX_SAFE_INTEGER,
		);

	test("is in the bar after the tracker while there is a job, and goes with the last", () => {
		expect(BoardTabs.order(base.tabs)).toEqual([null]);
		expect(BoardTabs.order(withTwo.tabs)).toEqual([null, BoardTabs.JOBS]);
		const onJobs = key(withTwo, "}").state;
		expect(onJobs.view).toEqual({ type: "jobs" });
		expect(onJobs.tabs.active).toBe(BoardTabs.JOBS);
		const gone = BoardTabs.withJobs(onJobs, []);
		expect(gone.tabs.active).toBeNull();
		expect(gone.view).toEqual({ type: "board" });
	});

	test("opens a job's detail and comes back to the tab, and pauses and resumes it", () => {
		const onJobs = key(withTwo, "}").state;
		const opened = key(onJobs, "return").state;
		expect(opened.view).toEqual({ type: "detail", taskId: "a" });
		expect(BoardNav.taskById(opened, "a")?.kind).toBe("job");
		expect(key(opened, "escape").state.view).toEqual({ type: "jobs" });
		const paused = key(onJobs, "s").effect;
		expect(paused).toMatchObject({
			type: "setState",
			id: "a",
			state: "someday",
		});
		const resumed = key(key(onJobs, "j").state, "n").effect;
		expect(resumed).toMatchObject({ type: "setState", id: "b", state: "next" });
		expect(key(onJobs, "a").effect).toEqual({
			type: "loadTriggers",
			taskId: "a",
		});
		expect(key(onJobs, "escape").state.tabs.active).toBeNull();
	});
});
