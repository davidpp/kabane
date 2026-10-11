import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LinkType, Planner, type TaskDraft } from "@cabane/core";
import { LoopPlan } from "./plan";
import { Stop } from "./stop";

let base = "";

const add = async (
	draft: Partial<TaskDraft> & { title: string },
): Promise<string> => {
	const created = await Planner.addTask(base, {
		kind: "issue",
		state: "next",
		...draft,
	});
	if (!created.ok) throw created.error;
	return created.value.id;
};

const link = async (sourceId: string, type: LinkType, targetId: string) => {
	const linked = await Planner.addLink(base, { sourceId, targetId, type });
	if (!linked.ok) throw linked.error;
};

const close = async (id: string) => {
	const done = await Planner.updateTask(base, id, { state: "done" });
	if (!done.ok) throw done.error;
};

const load = async (parentId: string): Promise<LoopPlan.Plan> => {
	const plan = await LoopPlan.load(base, parentId);
	if (!plan.ok) throw plan.error;
	return plan.value;
};

const titles = (nodes: LoopPlan.Node[]): string[] =>
	nodes.map((n) => n.task.title);

const NOW = new Date();
const NONE = new Set<string>();

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-plan-"));
	await Planner.init(base);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("LoopPlan.frontier", () => {
	it("follows blocks and blocked_by links in both directions", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent });
		const b = await add({ title: "b", parentTaskId: parent });
		const c = await add({ title: "c", parentTaskId: parent });
		await link(a, "blocks", b);
		await link(c, "blocked_by", b);

		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"a",
		]);
		await close(a);
		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"b",
		]);
		await close(b);
		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"c",
		]);
	});

	it("re-reads the plan: a subtask added mid-run joins the frontier", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "a", parentTaskId: parent });
		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"a",
		]);
		await add({ title: "added", parentTaskId: parent });
		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"a",
			"added",
		]);
	});

	it("leaves out live claims, parked or taken subtasks, deferred ones and p2 findings", async () => {
		const parent = await add({ title: "parent" });
		const live = await add({ title: "live", parentTaskId: parent });
		await add({ title: "waiting", parentTaskId: parent, state: "waiting" });
		await add({ title: "someday", parentTaskId: parent, state: "someday" });
		await add({ title: "taken", parentTaskId: parent, state: "in_progress" });
		await add({
			title: "deferred",
			parentTaskId: parent,
			deferUntil: new Date(NOW.getTime() + 86_400_000).toISOString(),
		});
		await add({
			title: "minor finding",
			parentTaskId: parent,
			tags: ["finding", "p2"],
		});
		await add({
			title: "blocking finding",
			parentTaskId: parent,
			tags: ["finding", "p1"],
		});
		await add({ title: "inbox", parentTaskId: parent, state: "inbox" });

		const plan = await load(parent);
		expect(titles(LoopPlan.frontier(plan, new Set([live]), NOW))).toEqual([
			"blocking finding",
			"inbox",
		]);
	});

	it("waits on an open blocker outside the plan, and not on a closed or deleted one", async () => {
		const parent = await add({ title: "parent" });
		const outside = await add({ title: "outside" });
		const gone = await add({ title: "gone" });
		const a = await add({ title: "a", parentTaskId: parent });
		await link(outside, "blocks", a);
		await link(gone, "blocks", a);
		const deleted = await Planner.deleteTask(base, gone);
		expect(deleted.ok).toBe(true);

		expect(LoopPlan.frontier(await load(parent), NONE, NOW)).toEqual([]);
		await close(outside);
		expect(titles(LoopPlan.frontier(await load(parent), NONE, NOW))).toEqual([
			"a",
		]);
	});
});

describe("LoopPlan.health", () => {
	it("is moving while something is ready or live", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent });
		const plan = await load(parent);
		expect(LoopPlan.health(plan, NONE, NOW).kind).toBe("moving");
		expect(LoopPlan.health(plan, new Set([a]), NOW).kind).toBe("moving");
	});

	it("is deadlocked on a cycle among open subtasks, naming it", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent });
		const b = await add({ title: "b", parentTaskId: parent });
		const c = await add({ title: "c", parentTaskId: parent });
		await link(a, "blocks", b);
		await link(b, "blocks", c);
		await link(c, "blocks", a);

		const health = LoopPlan.health(await load(parent), NONE, NOW);
		expect(health.kind).toBe("deadlocked");
		if (health.kind !== "deadlocked") return;
		expect(health.cycle).toHaveLength(3);
	});

	it("is waiting, not deadlocked, when what holds the run is outside it", async () => {
		const parent = await add({ title: "parent" });
		const parked = await add({
			title: "parked",
			parentTaskId: parent,
			state: "waiting",
		});
		const after = await add({ title: "after", parentTaskId: parent });
		const outside = await add({ title: "outside" });
		const other = await add({ title: "other", parentTaskId: parent });
		await link(parked, "blocks", after);
		await link(outside, "blocks", other);

		const plan = await load(parent);
		const health = LoopPlan.health(plan, NONE, NOW);
		expect(health.kind).toBe("waiting");
		if (health.kind !== "waiting") return;
		const short = (id: string): string =>
			[...plan.nodes.map((n) => n.task), ...plan.outside.values()].find(
				(t) => t.id === id,
			)?.shortId ?? id;
		expect(health.on.sort()).toEqual([short(parked), short(outside)].sort());
	});

	it("ignores a cycle once one of its members is closed", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent });
		const b = await add({ title: "b", parentTaskId: parent });
		await link(a, "blocks", b);
		await link(b, "blocks", a);
		await close(a);
		expect(LoopPlan.cycle(await load(parent))).toBeUndefined();
	});
});

describe("Stop.evaluate", () => {
	it("is done only when every subtask is closed and no p1 finding is open", async () => {
		const parent = await add({ title: "parent" });
		const a = await add({ title: "a", parentTaskId: parent });
		await add({
			title: "minor",
			parentTaskId: parent,
			tags: ["finding", "p3"],
		});
		expect(Stop.evaluate(await load(parent))).toEqual({
			done: false,
			openSubtasks: 1,
			openP1: 0,
		});

		await close(a);
		expect(Stop.evaluate(await load(parent))).toEqual({ done: true });

		const p1 = await add({
			title: "broken",
			parentTaskId: parent,
			tags: ["finding", "P1"],
		});
		expect(Stop.evaluate(await load(parent))).toEqual({
			done: false,
			openSubtasks: 0,
			openP1: 1,
		});
		await close(p1);
		expect(Stop.evaluate(await load(parent))).toEqual({ done: true });
	});

	it("counts a cancelled subtask as closed and a parked one as open", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "dropped", parentTaskId: parent, state: "cancelled" });
		expect(Stop.evaluate(await load(parent)).done).toBe(true);
		await add({ title: "parked", parentTaskId: parent, state: "waiting" });
		expect(Stop.evaluate(await load(parent)).done).toBe(false);
	});
});
