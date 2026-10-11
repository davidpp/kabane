import { describe, expect, it } from "bun:test";
import type { PanelLine } from "@cabane/board/ports";
import type { Task, TaskState } from "@cabane/core";
import { Briefing } from "./briefing";
import { LoopPlan } from "./plan";

const NOW = new Date("2026-10-11T12:00:00.000Z");

const task = (id: string, title: string, state: TaskState = "next"): Task => ({
	id,
	shortId: id,
	title,
	kind: "issue",
	state,
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-10-11T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-10-11T00:00:00.000Z",
	updatedAt: "2026-10-11T00:00:00.000Z",
});

const plan = (nodes: LoopPlan.Node[]): LoopPlan.Plan => ({
	parent: task("P-1", "parent"),
	nodes,
	outside: new Map(),
});

const text = (line: PanelLine): string => line.map((p) => p.text).join("");

// P-2 and P-3 start; P-4 waits on both; P-5 waits on P-4, which makes the longest chain.
const DIAMOND = plan([
	LoopPlan.node(task("P-2", "Parse the config"), []),
	LoopPlan.node(task("P-3", "Add a cache"), []),
	LoopPlan.node(task("P-4", "Serve reads through the cache"), ["P-2", "P-3"]),
	LoopPlan.node(task("P-5", "Document the cache"), ["P-4"]),
]);

describe("Briefing.criticalPath", () => {
	it("is the longest chain of open work, first to do first", () => {
		expect(Briefing.criticalPath(DIAMOND)).toEqual(["P-2", "P-4", "P-5"]);
	});

	it("skips closed work and does not loop on a cycle", () => {
		const cyclic = plan([
			LoopPlan.node(task("A", "a"), ["B"]),
			LoopPlan.node(task("B", "b"), ["A"]),
			LoopPlan.node(task("C", "c", "done"), []),
		]);
		expect(Briefing.criticalPath(cyclic).length).toBe(2);
	});
});

describe("Briefing.preview", () => {
	it("marks the ready work, lists every open blocker in full, and counts the plan", () => {
		const lines = Briefing.preview(DIAMOND, {}, [], NOW).map(text);
		expect(lines[0]).toBe("Plan  4 subtasks · 3 links · 2 ready");
		const row = (id: string) => lines.find((l) => l.includes(` ${id}  `));
		expect(row("P-2")).toMatch(/^ ● P-2 .*ready$/);
		expect(row("P-4")).toMatch(/^ ○ P-4 .*← P-2,P-3$/);
		expect(row("P-5")).toMatch(/← P-4$/);
		expect(lines).toContain("Critical path  P-2 → P-4 → P-5   3 deep");
		expect(lines.some((l) => l.startsWith("Risks"))).toBe(false);
	});

	it("a closed blocker no longer counts, and a parked subtask says where it is parked", () => {
		const moving = plan([
			LoopPlan.node(task("P-2", "first", "done"), []),
			LoopPlan.node(task("P-3", "second", "waiting"), ["P-2"]),
		]);
		const lines = Briefing.preview(moving, {}, [], NOW).map(text);
		expect(lines.find((l) => l.includes("P-2"))).toMatch(/^ ✓ P-2 .*done$/);
		expect(lines.find((l) => l.includes("P-3 "))).toMatch(/waiting$/);
	});

	it("lists the gates read-only, in order, and says where they are set", () => {
		const lines = Briefing.preview(
			DIAMOND,
			{ test: "bun test", typecheck: "bun run typecheck" },
			[],
			NOW,
		).map(text);
		const at = lines.findIndex((l) => l.startsWith("Gates"));
		expect(lines.slice(at, at + 3)).toEqual([
			"Gates  2  set in .kabane/loop.json or with --gate",
			" test       bun test",
			" typecheck  bun run typecheck",
		]);
		expect(Briefing.preview(DIAMOND, {}, [], NOW).map(text)).toContain(
			"Gates  none  set in .kabane/loop.json or with --gate",
		);
	});

	it("risks: the plan's own first (nothing ready), then lint's", () => {
		const stuck = plan([LoopPlan.node(task("P-2", "first", "waiting"), [])]);
		const lines = Briefing.preview(
			stuck,
			{},
			["P-2 has no brief (high)"],
			NOW,
		).map(text);
		const at = lines.indexOf("Risks  2");
		expect(at).toBeGreaterThan(0);
		expect(lines.slice(at + 1)).toEqual([
			" ! nothing is ready: waiting on P-2",
			" ! P-2 has no brief (high)",
		]);
	});
});
