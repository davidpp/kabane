import { expect, it } from "bun:test";
import type { ActivityEvent } from "@kabane/extension";
import { nowLines, orderedLiveLanes, trace } from "./now-feed";
import { Theme } from "./theme";
import { ToolRows } from "./tool-rows";

const event = (
	seq: number,
	lane: string | undefined,
	type: string,
	callId?: string,
): ActivityEvent => ({
	seq,
	at: new Date(seq * 1000).toISOString(),
	summary: `${type} ${seq}`,
	type,
	lane,
	callId,
});

it("filters by the live lanes, falling back to the run between sessions", () => {
	const gate: ActivityEvent = { ...event(1, "past", "done"), run: true };
	const next: ActivityEvent = { ...event(2, undefined, "progress"), run: true };
	const events = [
		gate,
		next,
		event(3, undefined, "text"),
		event(4, "A", "text"),
		event(5, "B", "thought"),
	];
	expect(nowLines(events, ["B", "A"])).toEqual(events.slice(3));
	expect(nowLines(events, ["A"])).toEqual(events.slice(3, 4));
	expect(nowLines(events, [])).toEqual([gate, next]);
});

it("updates each fold at its first call across other lanes, until its own lane speaks", () => {
	const lines = nowLines(
		[
			event(1, "A", "tool_call", "x"),
			event(2, "B", "tool_call", "x"),
			event(3, "B", "thought"),
			event(4, "A", "tool_call", "y"),
			event(5, "A", "tool_failed", "x"),
			event(6, "A", "text"),
			event(7, "A", "tool_completed", "y"),
			event(8, "A", "tool_call", "z"),
		],
		["A", "B"],
	);
	expect(lines.map((r) => [r.lane, r.type, r.summary])).toEqual([
		["A", "tools", "2 tools · 1 failed · 6.0s"],
		["B", "running-tools", "1 tool"],
		["B", "thought", "thought 3"],
		["A", "text", "text 6"],
		["A", "running-tools", "1 tool"],
	]);
});

it("only live sessions take one of the six series slots", () => {
	const lanes = ["a", "g", "h", "i", "j", "k", "l", "m"];
	const live = lanes.slice(1);
	const slots = Theme.liveSlots(6, lanes, live);
	expect(slots.has("a")).toBe(false);
	expect(new Set(live.slice(0, 6).map((lane) => slots.get(lane))).size).toBe(6);
	expect(slots.has("m")).toBe(false);
});

it("keeps a live session's slot while others start and end", () => {
	const lanes = ["first", "second", "third", "fourth"];
	const steps = [
		["first"],
		["second", "first"],
		["third", "second"],
		["fourth", "third"],
	];
	const seen = new Map<string, Set<number | undefined>>();
	let held: ReadonlyMap<string, number> = new Map();
	for (const liveLanes of steps) {
		const ordered = orderedLiveLanes({ lanes, liveLanes });
		expect(ordered).toEqual(liveLanes.toReversed());
		held = Theme.liveSlots(6, lanes, ordered, held);
		expect(new Set(held.values()).size).toBe(ordered.length);
		for (const lane of ordered)
			seen.set(lane, (seen.get(lane) ?? new Set()).add(held.get(lane)));
	}
	for (const slots of seen.values()) expect(slots.size).toBe(1);
});

it("keeps a slot through a collision, when the session that won it ends", () => {
	// Eight lanes on six slots: G's place gives slot 0, which A holds, so G took 1 and H 2.
	const lanes = ["A", "B", "C", "D", "E", "F", "G", "H"];
	const before = Theme.liveSlots(6, lanes, ["A", "G", "H"]);
	expect([...before]).toEqual([
		["A", 0],
		["G", 1],
		["H", 2],
	]);
	const after = Theme.liveSlots(6, lanes, ["G", "H"], before);
	expect([...after]).toEqual([
		["G", 1],
		["H", 2],
	]);
	// The slot A freed goes to a session that arrives later: six live, six slots, none shared.
	const full = Theme.liveSlots(6, lanes, ["B", "C", "D", "E", "G", "H"], after);
	expect(new Set(full.values())).toEqual(new Set([0, 1, 2, 3, 4, 5]));
	expect([full.get("G"), full.get("H")]).toEqual([1, 2]);
});

it("traces the steps, then the run's milestones from the whole run, not what a step already says", () => {
	const run = (
		seq: number,
		lane: string | undefined,
		type: string,
		summary: string,
		extra: Partial<ActivityEvent> = {},
	): ActivityEvent => ({
		...event(seq, lane, type),
		summary,
		run: true,
		...extra,
	});
	const claim = run(1, "A", "progress", "claude claims KAB-2: one");
	const merged = run(5, "A", "progress", "KAB-2 merged into kab-1 at abc123");
	const end = run(8, undefined, "progress", "completed: plan-done");
	const pruned = run(
		9,
		undefined,
		"done",
		"pruned · worktree and branch removed",
	);
	const lines = trace(
		{
			id: "card",
			kind: "activity",
			label: "Work",
			detail: [],
			status: "completed",
			startedAt: event(0, undefined, "phase").at,
			finishedAt: end.at,
			steps: [
				{ name: "implement", state: "done", durationMs: 1200 },
				{ name: "gates", state: "done", result: "ok · 2 passes" },
				{ name: "land", state: "pending" },
			],
		},
		[
			claim,
			{
				...event(2, "A", "phase"),
				summary: "claude claims KAB-2: one",
				includes: [1],
			},
			run(3, "A", "progress", "gates for KAB-2: ok"),
			run(4, "A", "done", "gates · KAB-2 · ok passed in 5ms"),
			merged,
			event(6, "A", "text"),
			run(7, undefined, "done", "land · none"),
			run(
				7,
				undefined,
				"warning",
				"gates not run for KAB-2: its worktree is gone",
			),
			end,
			pruned,
		],
	);
	expect(lines).toEqual([
		{ type: "done", durationMs: 1200, summary: "implement" },
		{ type: "done", durationMs: undefined, summary: "gates · ok · 2 passes" },
		merged,
		run(
			7,
			undefined,
			"warning",
			"gates not run for KAB-2: its worktree is gone",
		),
		end,
		pruned,
	]);
});

it("times a fold as the log does: two overlapping 5s calls took 5s on both", () => {
	const events: ActivityEvent[] = [
		event(1, "A", "tool_call", "x"),
		event(1, "A", "tool_call", "y"),
		{ ...event(6, "A", "tool_completed", "x"), seq: 3 },
		{ ...event(6, "A", "tool_completed", "y"), seq: 4 },
	].map((e, n) => ({ ...e, seq: n + 1 }));
	expect(nowLines(events, ["A"]).map((line) => line.summary)).toEqual([
		"2 tools · 5.0s",
	]);
	const [group] = ToolRows.rows(events, true);
	if (group?.type !== "group") throw new Error("expected a group");
	expect(ToolRows.groupLabel(group.group)).toBe("2 tools · 5.0s");
});
