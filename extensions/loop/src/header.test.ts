import { describe, expect, it } from "bun:test";
import type { Task } from "@cabane/core";
import { LoopConfig } from "./config";
import { LoopHeader } from "./header";
import type { LoopPlan } from "./plan";
import type { RunStore } from "./store";

const NOW = new Date("2026-10-10T12:30:00.000Z");

const run = (
	over: Partial<RunStore.Run> = {},
	budget: Partial<LoopConfig.Input["budget"]> = {},
): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({ budget });
	if (!config.success) throw config.error;
	return {
		version: 1,
		id: "KAB-1-abc",
		parentId: "01PARENT",
		parentShortId: "KAB-1",
		projectDir: "/repo",
		config: config.data,
		status: "running",
		createdAt: "2026-10-10T12:00:00.000Z",
		startedAt: "2026-10-10T12:00:00.000Z",
		claims: [
			{
				taskId: "01CHILD",
				shortId: "KAB-2",
				harness: "claude",
				lane: "claude:KAB-2",
				sessionId: "s1",
				startedAt: "2026-10-10T12:00:01.000Z",
				endedAt: "2026-10-10T12:10:00.000Z",
				continuations: 0,
			},
			{
				taskId: "01CHILD",
				shortId: "KAB-2",
				harness: "claude",
				lane: "claude:KAB-2#2",
				sessionId: "s2",
				startedAt: "2026-10-10T12:10:01.000Z",
				continuations: 0,
			},
		],
		usage: {
			s1: { used: 900, size: 1000, cost: { amount: 1, currency: "USD" } },
			s2: { used: 250, size: 1000, cost: { amount: 0.5, currency: "USD" } },
		},
		continuationsUsed: 1,
		inboxRead: 0,
		steering: { paused: false, skipped: [], next: [] },
		gateRuns: [],
		...over,
	};
};

describe("LoopHeader.meters", () => {
	it("context from the live sessions and continuations used, without a time limit", () => {
		expect(LoopHeader.meters(run())).toEqual([
			{ label: "context", share: 0.25, text: "25%" },
			{ label: "continuations", share: 1 / 3, text: "1/3" },
		]);
	});

	it("spend only when the run has a spend budget, summed over every session", () => {
		const [spend] = LoopHeader.meters(run({}, { spend: 10 }));
		expect(spend).toEqual({ label: "spend", share: 0.15, text: "1.50/10 USD" });
	});
});

describe("LoopHeader.cells", () => {
	it("shows anything used as one cell at least, and never overflows", () => {
		expect(LoopHeader.cells(0)).toEqual({ filled: 0, empty: 10 });
		expect(LoopHeader.cells(0.01)).toEqual({ filled: 1, empty: 9 });
		expect(LoopHeader.cells(0.55)).toEqual({ filled: 6, empty: 4 });
		expect(LoopHeader.cells(3)).toEqual({ filled: 10, empty: 0 });
	});
});

describe("LoopHeader.state", () => {
	it("a stopped run says it stopped and why, without reading as failed", () => {
		const stopped = run({
			status: "stopped",
			exit: { reason: "stalled", detail: "no progress across 3 session ends" },
		});
		expect(LoopHeader.state(stopped, null, NOW)).toEqual({
			text: "⏹ stopped · stalled (no progress across 3 session ends)",
			tone: "muted",
			bold: true,
		});
	});

	it("a run whose runner died names the key that restarts it, and no other failed run does", () => {
		const died = (reason: string) =>
			LoopHeader.state(
				run({ status: "failed", exit: { reason, detail: "pid 7" } }),
				null,
				NOW,
			).text;
		expect(died("runner-died")).toBe("✗ runner-died (pid 7) · r restarts");
		expect(died("runner-exited")).toBe("✗ runner-exited (pid 7)");
	});

	it("a running run counts automatic attempts that moved nothing", () => {
		expect(
			LoopHeader.state(run({ stall: { mark: "m", unchanged: 2 } }), null, NOW)
				.text,
		).toBe("● no progress across 2 of 3 attempts");
		expect(LoopHeader.state(run(), null, NOW).text).toBe("● running");
	});

	it("a paused run says so before anything else about its health", () => {
		const paused = run({ steering: { paused: true, skipped: [], next: [] } });
		expect(LoopHeader.state(paused, null, NOW).text).toBe(
			"⏸ paused · 1 session finishing · p resumes",
		);
	});
});

describe("LoopHeader.steps", () => {
	const text = (r: RunStore.Run): string =>
		LoopHeader.steps(r, null)
			.map((part) => part.text)
			.join("");
	const gated = (gateRuns: RunStore.Run["gateRuns"]): RunStore.Run => {
		const config = LoopConfig.Schema.safeParse({
			gates: { test: "bun test", lint: "bun run check" },
		});
		if (!config.success) throw config.error;
		return run({ config: config.data, gateRuns, worktree: "/wt" });
	};
	const result = (name: string, ok: boolean) => ({
		name,
		command: name,
		ok,
		exit: ok ? 0 : 1,
		ms: 1000,
		tail: "",
	});

	it("shows the gates only for a run that has some, by their last pass", () => {
		expect(text(run())).toBe("● implement ×2 sessions");
		expect(text(gated([]))).toBe(
			"● implement ×2 sessions  ›  ○ gates test·lint",
		);
		expect(
			text(
				gated([
					{
						at: "2026-10-10T12:05:00.000Z",
						results: [result("test", true), result("lint", true)],
						ok: true,
						tree: "t",
						checkpoint: "abc123",
					},
					{
						at: "2026-10-10T12:20:00.000Z",
						results: [result("test", false)],
						ok: false,
						tree: "t2",
					},
				]),
			),
		).toBe("● implement ×2 sessions  ›  ✗ gates test red · 1 checkpoint");
	});

	it("counts the lenses' sessions apart from the work, and shows a recheck once one runs", () => {
		const config = LoopConfig.Schema.safeParse({ lenses: ["functional"] });
		if (!config.success) throw config.error;
		const onParent = (extra: Partial<RunStore.Claim>): RunStore.Claim => ({
			taskId: "01PARENT",
			shortId: "KAB-1",
			harness: "claude",
			lane: "review",
			sessionId: `s-${JSON.stringify(extra)}`,
			startedAt: "2026-10-10T12:20:00.000Z",
			endedAt: "2026-10-10T12:21:00.000Z",
			outcome: "done",
			continuations: 0,
			...extra,
		});
		const base = run({ status: "running", config: config.data });
		const rechecking = run({
			config: config.data,
			claims: [
				...base.claims.map((c) => ({ ...c, endedAt: c.startedAt })),
				onParent({ lens: "functional" }),
				onParent({ fixer: true, head: "abc123", findings: [] }),
				onParent({
					recheck: "functional",
					endedAt: undefined,
					outcome: undefined,
				}),
			],
		});
		const parent = { id: "01PARENT", shortId: "KAB-1" } as Task;
		const plan = { parent, nodes: [], outside: new Map() };
		expect(
			LoopHeader.steps(rechecking, plan)
				.map((part) => part.text)
				.join(""),
		).toBe(
			"○ implement ×2 sessions  ›  ✓ lenses functional  ›  ✓ fixer 0/0 closed  ›  ● recheck functional",
		);
	});
});

describe("LoopHeader.state past the subtasks", () => {
	const parent = { id: "01PARENT", shortId: "KAB-1", title: "parent" } as Task;
	const child = (
		shortId: string,
		state: Task["state"],
		kind: Task["kind"] = "issue",
	): LoopPlan.Node => ({
		task: {
			id: `01${shortId}`,
			shortId,
			title: shortId,
			state,
			kind,
			tags: [] as string[],
		} as Task,
		blockedBy: [],
		finding: false,
		severity: undefined,
	});
	const plan = (...nodes: LoopPlan.Node[]): LoopPlan.Plan => ({
		parent,
		nodes,
		outside: new Map(),
	});
	const allDone = plan(child("KAB-2", "done"));
	const ended = run().claims.map((c) => ({ ...c, endedAt: c.startedAt }));
	const onParent = (extra: Partial<RunStore.Claim>): RunStore.Claim => ({
		taskId: "01PARENT",
		shortId: "KAB-1",
		harness: "claude",
		lane: `review-${JSON.stringify(extra)}`,
		sessionId: `s-${JSON.stringify(extra)}`,
		startedAt: "2026-10-10T12:20:00.000Z",
		continuations: 0,
		...extra,
	});
	const configured = (input: LoopConfig.Input): RunStore.Run["config"] => {
		const config = LoopConfig.Schema.safeParse(input);
		if (!config.success) throw config.error;
		return config.data;
	};
	const green = {
		at: "2026-10-10T12:19:00.000Z",
		results: [],
		ok: true,
		tree: "t",
	};
	const text = (r: RunStore.Run, p: LoopPlan.Plan | null = allDone): string =>
		LoopHeader.state(r, p, NOW).text;

	it("names the closing gates while they run, and the gates step shows them running", () => {
		const gating = run({
			claims: ended,
			gating: ["KAB-1"],
			config: configured({ gates: { test: "bun test" } }),
			gateRuns: [green],
		});
		expect(LoopHeader.state(gating, allDone, NOW)).toEqual({
			text: "● closing gates for KAB-1",
			tone: "working",
			bold: true,
		});
		expect(
			LoopHeader.steps(gating, allDone)
				.map((part) => part.text)
				.join(""),
		).toBe("○ implement ×2 sessions  ›  ◐ gates running for KAB-1");
	});

	it("shows a subtask's pass running in the gates step while its session is still the run's", () => {
		const gating = run({
			gating: ["KAB-2"],
			config: configured({ gates: { test: "bun test" } }),
		});
		expect(text(gating, plan(child("KAB-2", "in_progress")))).toBe("● running");
		expect(
			LoopHeader.steps(gating, null)
				.map((part) => part.text)
				.join(""),
		).toBe("● implement ×2 sessions  ›  ◐ gates running for KAB-2");
	});

	it("never shows a pass running for a run whose runner is gone", () => {
		const dead = run({
			status: "failed",
			exit: { reason: "runner-died" },
			gating: ["KAB-1"],
			config: configured({ gates: { test: "bun test" } }),
		});
		expect(
			LoopHeader.steps(dead, null)
				.map((part) => part.text)
				.join(""),
		).toBe("✗ implement ×2 sessions  ›  ○ gates test");
	});

	it("names the lenses reviewing, the fixer, and the lenses rechecking", () => {
		expect(
			text(run({ claims: [...ended, onParent({ lens: "quality" })] })),
		).toBe("● quality lens reviewing");
		expect(
			text(
				run({
					claims: [
						...ended,
						onParent({ lens: "quality" }),
						onParent({ lens: "docs" }),
					],
				}),
			),
		).toBe("● quality, docs lenses reviewing");
		expect(
			text(
				run({
					claims: [...ended, onParent({ fixer: true, findings: ["a", "b"] })],
				}),
			),
		).toBe("● fixer on 2 findings");
		expect(
			text(run({ claims: [...ended, onParent({ recheck: "functional" })] })),
		).toBe("● functional lens rechecking the fixer's diff");
	});

	it("says landing once every step before it is done, and while a landing is under way", () => {
		const landing = run({
			claims: ended,
			config: configured({ land: "pr" }),
			gateRuns: [green],
		});
		expect(text(landing)).toBe("● landing");
		expect(text({ ...landing, gating: ["KAB-1"], landingFrom: "abc" })).toBe(
			"● landing",
		);
	});

	it("says it is closing the parent between two steps, never that it waits on nothing", () => {
		expect(text(run({ claims: ended }))).toBe("● closing KAB-1");
	});

	it("names what holds the run, and the way out when only a human can release it", () => {
		const held = run({ claims: ended });
		const parked = LoopHeader.state(
			held,
			plan(child("KAB-2", "done"), child("KAB-3", "someday")),
			NOW,
		);
		expect(parked).toEqual({
			text: "⏸ waiting on KAB-3 (someday) · set it to next or close it",
			tone: "accent",
			bold: true,
		});
		expect(
			text(
				held,
				plan(child("KAB-3", "waiting"), child("KAB-4", "in_progress")),
			),
		).toBe(
			"⏸ waiting on KAB-3 (waiting), KAB-4 (in_progress, not the run's) · set them to next or close them",
		);
		expect(
			text(
				held,
				plan(child("KAB-3", "someday"), child("KAB-4", "next", "task")),
			),
		).toBe("⏸ waiting on KAB-3 (someday), KAB-4 (a human's task)");
	});
});
