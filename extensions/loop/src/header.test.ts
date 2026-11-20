import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import "@kabane/core/testing";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@kabane/core";
import type { ActivityCard } from "@kabane/extension";
import { LoopConfig } from "./config";
import { LoopHeader } from "./header";
import type { LoopPlan } from "./plan";
import { RunStore } from "./store";
import { testHost } from "./test-host";

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
		// Running is work in flight, in the working hue, named by the step it is on.
		expect(LoopHeader.state(run(), null, NOW)).toEqual({
			text: "● implement",
			tone: "working",
			bold: true,
		});
	});

	it("a paused run says so before anything else about its health", () => {
		const paused = run({ steering: { paused: true, skipped: [], next: [] } });
		expect(LoopHeader.state(paused, null, NOW).text).toBe(
			"⏸ paused · 1 session finishing · p resumes",
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

	it("names the step under way: the gates, a review, the fixer, a recheck, the landing", () => {
		const gates = configured({ gates: { test: "bun test" } });
		expect(
			text(
				run({
					claims: ended,
					gating: ["KAB-1"],
					config: gates,
					gateRuns: [green],
				}),
			),
		).toBe("● gates");
		const lenses = configured({ lenses: ["quality"] });
		expect(
			text(
				run({
					config: lenses,
					claims: [...ended, onParent({ lenses: ["quality"] })],
				}),
			),
		).toBe("● review");
		expect(
			text(
				run({
					config: lenses,
					claims: [...ended, onParent({ fixer: true, findings: ["a", "b"] })],
				}),
			),
		).toBe("● fixer");
		expect(
			text(
				run({
					claims: [...ended],
					landingFrom: "abc",
					config: configured({ land: "pr" }),
				}),
			),
		).toBe("● land");
	});

	it("never shows a pass running for a run whose runner is gone", () => {
		const dead = run({
			status: "failed",
			exit: { reason: "runner-died" },
			gating: ["KAB-1"],
			config: configured({ gates: { test: "bun test" } }),
		});
		expect(text(dead)).toBe("✗ runner-died · r restarts");
	});

	it("between two steps it names the next one, never that it waits on nothing", () => {
		expect(
			text(
				run({ claims: ended, config: configured({ gates: { t: "true" } }) }),
			),
		).toBe("● gates");
	});

	it("names the session a question waits on before anything else", () => {
		expect(LoopHeader.state(run(), allDone, NOW, "docs-recheck")).toEqual({
			text: "? docs-recheck waits on you",
			tone: "accent",
			bold: true,
		});
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

describe("LoopHeader.lines", () => {
	const textOf = (rows: readonly (readonly { text: string }[])[]): string[] =>
		rows.map((row) => row.map((part) => part.text).join(""));
	const parent = {
		id: "01PARENT",
		shortId: "KAB-1",
		title: "revise the brief",
	} as Task;
	const plan: LoopPlan.Plan = { parent, nodes: [], outside: new Map() };

	it("is one row: the parent and title on the left, the state and its facts on the right", () => {
		const rows = textOf(LoopHeader.lines(run(), plan, NOW, 90));
		expect(rows).toEqual([
			"KAB-1  revise the …  ● implement · 2 sessions · 1 live · 30m0s · $1.50 · 1/3 continuations",
		]);
		expect(rows[0]?.length).toBe(90);
	});

	it("gives up the title, then the facts from the least needed, and keeps the state", () => {
		expect(textOf(LoopHeader.lines(run(), plan, NOW, 40))).toEqual([
			"KAB-1  ● implement · 2 sessions · 1 live",
		]);
		expect(textOf(LoopHeader.lines(run(), plan, NOW, 20))).toEqual([
			"KAB-1  ● implement",
		]);
	});

	it("says what an over run left in short when the long form does not fit", () => {
		const parentOnly = { ...plan, nodes: [] };
		const over = run({
			status: "completed",
			endedAt: "2026-10-10T12:30:00.000Z",
			worktree: "/wt",
		});
		const finding = {
			task: {
				id: "01F1",
				shortId: "KAB-9",
				title: "a finding",
				state: "next",
				tags: ["finding", "functional"],
			} as Task,
			blockedBy: [],
			finding: true,
			severity: undefined,
		};
		const left = { ...parentOnly, nodes: [finding] };
		expect(textOf(LoopHeader.lines(over, left, NOW, 60))[0]).toEndWith(
			"✓ completed · 1 finding left for you · 30m0s · $1.50",
		);
		expect(textOf(LoopHeader.lines(over, left, NOW, 30))[0]).toBe(
			"KAB-1   ✓ completed · 1 left",
		);
	});

	it("preserves stopped and failed state text", () => {
		for (const status of ["stopped", "failed"] as const) {
			const current = run({ status, exit: { reason: "runner-died" } });
			expect(LoopHeader.lines(current, null, NOW, 20)[0]).toContainEqual(
				LoopHeader.state(current, null, NOW),
			);
		}
	});
});

it("reads the real run file and current tracker plan on each header call", async () => {
	const home = mkdtempSync(join(tmpdir(), "loop-header-"));
	try {
		const initialized = await Planner.init(home);
		if (!initialized.ok) throw initialized.error;
		const parent = await Planner.addTask(home, {
			title: "Header parent",
			kind: "issue",
		});
		if (!parent.ok) throw parent.error;
		const child = await Planner.addTask(home, {
			title: "Header child",
			kind: "issue",
			parentTaskId: parent.value.id,
		});
		if (!child.ok) throw child.error;
		const current = run({
			status: "completed",
			parentId: parent.value.id,
			parentShortId: parent.value.shortId ?? parent.value.id,
		});
		const created = RunStore.create(home, current);
		if (!created.ok) throw created.error;
		const card: ActivityCard = {
			id: current.id,
			kind: "loops",
			label: "Header parent",
			status: "completed",
			startedAt: current.createdAt,
			detail: [],
		};
		const header = LoopHeader.make(home, testHost(home).record);
		const first = await header(card, { width: 100, expanded: true });
		if (!first.ok) throw first.error;
		expect(
			first.value
				.flat()
				.map((part) => part.text)
				.join(""),
		).toContain("Header parent");
		const updated = await Planner.updateTask(home, parent.value.id, {
			title: "Updated parent",
		});
		if (!updated.ok) throw updated.error;
		const second = await header(card, { width: 100, expanded: true });
		if (!second.ok) throw second.error;
		expect(
			second.value
				.flat()
				.map((part) => part.text)
				.join(""),
		).toContain("Updated parent");
		rmSync(RunStore.paths(home, current.id).run);
		expect((await header(card, { width: 100, expanded: false })).ok).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
