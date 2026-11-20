import { expect, it } from "bun:test";
import type { ActivityEvent } from "@kabane/extension";
import { nowLines } from "./now-feed";
import { Theme } from "./theme";

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
	const events = [
		event(1, "past", "text"),
		event(2, undefined, "progress"),
		event(3, "A", "text"),
		event(4, "B", "thought"),
	];
	expect(nowLines(events, ["B", "A"])).toEqual(events.slice(2));
	expect(nowLines(events, ["A"])).toEqual(events.slice(2, 3));
	expect(nowLines(events, [])).toEqual(events.slice(1, 2));
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
		["A", "tools", "2 tools · 1 failed · 6s"],
		["B", "running-tools", "1 tool"],
		["B", "thought", "thought 3"],
		["A", "text", "text 6"],
		["A", "running-tools", "1 tool"],
	]);
});

it("only live sessions consume the six distinct series hues", () => {
	const lanes = ["g", "h", "i", "j", "k", "l"];
	expect(lanes.map((lane) => Theme.liveHue(Theme.DARK, lanes, lane))).toEqual([
		...Theme.DARK.series,
	]);
	expect(Theme.liveHue(Theme.DARK, lanes, "a")).toBe(Theme.DARK.secondary);
});
