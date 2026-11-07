import { describe, expect, it } from "bun:test";
import type { Task } from "@cabane/core";
import { LoopConfig } from "./config";
import { LoopHeader } from "./header";
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
