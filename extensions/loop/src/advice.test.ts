import { expect, test } from "bun:test";
import type { Task, TaskState, Risk } from "@cabane/core";
import { LoopAdvice } from "./advice";
import { LoopConfig } from "./config";
import { LoopPlan } from "./plan";

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

const config = (input: LoopConfig.Input = {}): LoopConfig.Config => {
	const result = LoopConfig.Schema.safeParse(input);
	if (!result.success) throw result.error;
	return result.data;
};
const project = (input: LoopConfig.Input = {}): LoopAdvice.Project => ({
	config: config(input),
	scripts: {},
	lockfiles: [],
});
const node = (id: string, blockers: string[] = [], file = "") =>
	LoopPlan.node({ ...task(id, id), description: file }, blockers);
const recommendation = (
	nodes: LoopPlan.Node[],
	risks: Risk[] = [],
	p = project(),
) => LoopAdvice.of(plan(nodes), risks, p);
const overlap: Risk = {
	type: "file_overlap",
	message: "opaque risk wording",
	severity: "medium",
};

test("concurrency: single, chain, later fan-out, and cap", () => {
	for (const [nodes, expected] of [
		[[node("A")], 1],
		[[node("A"), node("B", ["A"]), node("C", ["B"])], 1],
		[[node("A"), node("B", ["A"]), node("C", ["A"])], 2],
		[Array.from({ length: 10 }, (_, i) => node(String(i))), 8],
	] as const)
		expect(recommendation([...nodes])[0]?.value).toBe(expected);
});

test("concurrency uses the maximum antichain, not synchronous topological layers", () => {
	// A can be held while B finishes, making A, C, D ready together.
	expect(
		recommendation([
			node("A"),
			node("B"),
			node("C", ["B"]),
			node("D", ["B"]),
		])[0]?.value,
	).toBe(3);
});

test("parallel overlap serializes; overlap between ordered issues leaves the unrelated parallel work", () => {
	const a = node("A", [], "src/shared.ts");
	const b = node("B", [], "src/shared.ts");
	expect(recommendation([a, b], [overlap])[0]).toMatchObject({
		value: 1,
		reason: expect.stringContaining("src/shared.ts"),
	});
	const ordered = [a, { ...b, blockedBy: ["A"] }, node("C")];
	expect(recommendation(ordered, [overlap])[0]?.value).toBe(2);
	// A and B never run together, so their overlap asks nothing of a shared tree: only C runs beside
	// A, and the shared tree keeps it to one session.
	expect(
		recommendation(ordered, [overlap], project({ isolation: "shared" })),
	).toEqual([
		{
			path: "budget.concurrency",
			value: 1,
			reason:
				"subtasks share one tree; their gates see each other's half-done edits",
		},
	]);
	expect(
		recommendation([a, b], [{ ...overlap, type: "no_tests" }])[0]?.value,
	).toBe(2);
});

test("a shared tree is advised one session however wide the plan; worktrees get the width", () => {
	const wide = ["A", "B", "C", "D"].map((id) => node(id));
	expect(recommendation(wide)[0]).toEqual({
		path: "budget.concurrency",
		value: 4,
		reason: "up to 4 independent issues in the blocker DAG",
	});
	for (const shared of [
		project({ isolation: "shared" }),
		project({ worktree: false }),
	])
		expect(recommendation(wide, [], shared)[0]).toEqual({
			path: "budget.concurrency",
			value: 1,
			reason:
				"subtasks share one tree; their gates see each other's half-done edits",
		});
	expect(
		recommendation(
			[node("A"), node("B", ["A"])],
			[],
			project({ isolation: "shared" }),
		)[0]?.reason,
	).toBe("up to 1 independent issues in the blocker DAG");
});

test("closed nodes, findings and human tasks do not add sessions; cycles remain safe", () => {
	expect(
		recommendation([
			node("A"),
			{ ...node("B"), task: task("B", "closed", "done") },
			{ ...node("F"), finding: true },
			{ ...node("H"), task: { ...task("H", "human"), kind: "task" } },
		])[0]?.value,
	).toBe(1);
	expect(recommendation([node("A", ["B"]), node("B", ["A"])])[0]?.value).toBe(
		1,
	);
});

test("gates and setup use only project scripts and the lockfile's package manager", () => {
	for (const [lock, manager, install] of [
		["bun.lock", "bun", "bun install"],
		["bun.lockb", "bun", "bun install"],
		["pnpm-lock.yaml", "pnpm", "pnpm install"],
		["package-lock.json", "npm", "npm ci"],
		["yarn.lock", "yarn", "yarn install"],
	]) {
		const advice = recommendation([node("A")], [], {
			...project(),
			scripts: { check: "check", test: "test", build: "build" },
			lockfiles: [lock ?? ""],
		});
		expect(advice.find((r) => r.path === "gates")?.value).toEqual({
			check: `${manager} run check`,
			test: `${manager} run test`,
		});
		expect(advice.find((r) => r.path === "setup")?.value).toBe(install);
	}
	expect(
		recommendation([node("A")], [], {
			...project(),
			scripts: { test: "test" },
		}).some((r) => r.path === "gates"),
	).toBe(false);
	expect(
		recommendation([node("A")], [], {
			...project({ gates: { custom: "verify" }, isolation: "shared" }),
			lockfiles: ["bun.lock"],
			scripts: { test: "test" },
		}).map((r) => r.path),
	).toEqual(["budget.concurrency"]);
});

test("past thrash advises two stalls by risk type, regardless of message wording", () => {
	expect(
		recommendation(
			[node("A")],
			[{ type: "past_thrash", message: "repeated reopens", severity: "high" }],
		),
	).toContainEqual({
		path: "stallAfter",
		value: 2,
		reason: "repeated reopens",
	});
	expect(recommendation([node("A")]).some((r) => r.path === "stallAfter")).toBe(
		false,
	);
});
