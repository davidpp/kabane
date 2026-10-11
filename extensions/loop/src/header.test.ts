import { describe, expect, it } from "bun:test";
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
		...over,
	};
};

describe("LoopHeader.meters", () => {
	it("time against the wall budget, context from the live sessions, continuations used", () => {
		expect(LoopHeader.meters(run(), NOW)).toEqual([
			{ label: "time", share: 0.25, text: "30m/120m" },
			{ label: "context", share: 0.25, text: "25%" },
			{ label: "continuations", share: 1 / 3, text: "1/3" },
		]);
	});

	it("spend only when the run has a spend budget, summed over every session", () => {
		const [, spend] = LoopHeader.meters(run({}, { spend: 10 }), NOW);
		expect(spend).toEqual({ label: "spend", share: 0.15, text: "1.50/10 USD" });
	});

	it("a finished run's time stops at its end", () => {
		const [time] = LoopHeader.meters(
			run({ status: "stopped", endedAt: "2026-10-10T12:12:00.000Z" }),
			NOW,
		);
		expect(time?.text).toBe("12m/120m");
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

	it("a running run counts the session ends that moved nothing", () => {
		expect(
			LoopHeader.state(run({ stall: { mark: "m", unchanged: 2 } }), null, NOW)
				.text,
		).toBe("● no progress across 2 of 3 session ends");
		expect(LoopHeader.state(run(), null, NOW).text).toBe(
			"● healthy · claiming ready work",
		);
	});
});
