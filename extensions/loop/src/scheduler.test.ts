import "./test-host";
import "@kabane/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type TaskDraft } from "@kabane/core";
import { LoopPlan } from "./plan";
import { Scheduler } from "./scheduler";

let base = "";

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-scheduler-"));
	await Planner.init(base);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

// Core stamps createdAt to the millisecond, so two tasks added back to back can share one; a
// test that relies on creation order gives each its own.
const node = async (
	draft: Partial<TaskDraft> & { title: string },
	createdAt?: string,
): Promise<LoopPlan.Node> => {
	const created = await Planner.addTask(base, {
		kind: "issue",
		state: "next",
		...draft,
	});
	if (!created.ok) throw created.error;
	return LoopPlan.node(
		createdAt ? { ...created.value, createdAt } : created.value,
		[],
	);
};

const titles = (nodes: LoopPlan.Node[]): string[] =>
	nodes.map((n) => n.task.title);

describe("Scheduler.pick", () => {
	it("fills only the free slots, by priority and then plan order", async () => {
		const first = await node({ title: "first" }, "2026-11-20T00:00:00.001Z");
		const urgent = await node({ title: "urgent", priority: "urgent" });
		const second = await node({ title: "second" }, "2026-11-20T00:00:00.002Z");
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
