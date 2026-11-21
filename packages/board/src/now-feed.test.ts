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

it("only live sessions consume the six distinct series hues", () => {
	const lanes = ["a", "g", "h", "i", "j", "k", "l", "m"];
	const live = lanes.slice(1);
	const hues = Theme.liveHues(Theme.DARK, lanes, live);
	expect(hues.has("a")).toBe(false);
	expect(new Set(live.slice(0, 6).map((lane) => hues.get(lane))).size).toBe(6);
	expect(hues.get("m")).toBe(Theme.DARK.secondary);
});

it("keeps a live session's hue while others start and end", () => {
	const lanes = ["first", "second", "third", "fourth"];
	const steps = [
		["first"],
		["second", "first"],
		["third", "second"],
		["fourth", "third"],
	];
	const seen = new Map<string, Set<string | undefined>>();
	for (const liveLanes of steps) {
		const ordered = orderedLiveLanes({ lanes, liveLanes });
		expect(ordered).toEqual(liveLanes.toReversed());
		const hues = Theme.liveHues(Theme.DARK, lanes, ordered);
		expect(new Set(hues.values()).size).toBe(ordered.length);
		for (const lane of ordered)
			seen.set(lane, (seen.get(lane) ?? new Set()).add(hues.get(lane)));
	}
	for (const hues of seen.values()) expect(hues.size).toBe(1);
});

it("traces timed steps from the card and run events from completion onwards", () => {
	const finished = event(2, undefined, "done");
	const after: ActivityEvent = { ...event(3, "A", "done"), run: true };
	const lines = trace(
		{
			id: "card",
			kind: "activity",
			label: "Work",
			detail: [],
			status: "completed",
			startedAt: event(0, undefined, "phase").at,
			finishedAt: finished.at,
			steps: [
				{ name: "inspect", state: "done", durationMs: 1200 },
				{ name: "optional", state: "pending" },
			],
		},
		[
			{ ...event(1, "A", "done"), summary: "unrelated wording", run: true },
			finished,
			after,
		],
	);
	expect(lines).toEqual([
		{ type: "done", durationMs: 1200, summary: "inspect" },
		after,
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
