import "@cabane/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type TaskDraft } from "@cabane/core";
import { LoopPlan } from "./plan";
import { Scheduler } from "./scheduler";

let base = "";

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-scheduler-"));
	await Planner.init(base);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const node = async (
	draft: Partial<TaskDraft> & { title: string },
): Promise<LoopPlan.Node> => {
	const created = await Planner.addTask(base, {
		kind: "issue",
		state: "next",
		...draft,
	});
	if (!created.ok) throw created.error;
	return LoopPlan.node(created.value, []);
};

const titles = (nodes: LoopPlan.Node[]): string[] =>
	nodes.map((n) => n.task.title);

describe("Scheduler.pick", () => {
	it("fills only the free slots, by priority and then plan order", async () => {
		const first = await node({ title: "first" });
		const urgent = await node({ title: "urgent", priority: "urgent" });
		const second = await node({ title: "second" });
		const low = await node({ title: "low", priority: "low" });
		const ready = [low, second, first, urgent];

		expect(titles(Scheduler.pick(ready, 2))).toEqual(["urgent", "first"]);
		expect(titles(Scheduler.pick(ready, 10))).toEqual([
			"urgent",
			"first",
			"second",
			"low",
		]);
		expect(Scheduler.pick(ready, 0)).toEqual([]);
	});

	it("claims continuously: a freed slot takes the next ready subtask", async () => {
		const a = await node({ title: "a" });
		const b = await node({ title: "b" });
		const c = await node({ title: "c" });
		// Cap 2: a and b are claimed; when a ends the next tick has one slot and c is ready.
		expect(titles(Scheduler.pick([a, b, c], 2))).toEqual(["a", "b"]);
		expect(titles(Scheduler.pick([c], 1))).toEqual(["c"]);
	});
});
