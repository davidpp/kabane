/** @jsxImportSource @opentui/react */
// The cockpit's arrangement: where the tab splits, whose log its right column follows, how many rows
// "now" takes over a log, how the run's facts pack, and that the footer keeps the bottom rows of the
// gallery's run tabs, stacked and split.
import { describe, expect, it } from "bun:test";
import type { ActivityCard, ActivityStep } from "@kabane/extension";
import { Cockpit } from "./cockpit";
import { STORIES } from "./stories";
import { pumpUntil, renderTest } from "./testing";

const RECHECK: ActivityStep = {
	name: "recheck",
	state: "running",
	sessions: [
		{ name: "functional", state: "done", lane: "functional-recheck" },
		{ name: "docs", state: "running", lane: "docs-recheck" },
		{ name: "design", state: "pending" },
	],
};
const CARD = {
	steps: [{ name: "gates", state: "done" }, RECHECK] satisfies ActivityStep[],
	liveLanes: ["docs-recheck"],
};
const moved = (cursor: string) => ({ cursor, follow: false });

describe("Cockpit", () => {
	it("splits from 160 columns and stacks below", () => {
		expect(Cockpit.split(159)).toBe(false);
		expect(Cockpit.split(160)).toBe(true);
		expect(Cockpit.split(200)).toBe(true);
	});

	it("follows the session under the cursor, and the log enter opened over it", () => {
		// Following the run: the live session.
		expect(Cockpit.logLane(CARD, {})).toBe("docs-recheck");
		expect(
			Cockpit.logLane(CARD, moved("step:recheck/functional-recheck")),
		).toBe("functional-recheck");
		// A step, and a session still to come, open no log.
		expect(Cockpit.logLane(CARD, moved("step:gates"))).toBeUndefined();
		expect(Cockpit.logLane(CARD, moved("step:recheck/design"))).toBeUndefined();
		expect(
			Cockpit.logLane(CARD, { ...moved("step:gates"), lane: "docs-recheck" }),
		).toBe("docs-recheck");
	});

	it("drops now over the log only when the one live session is that log", () => {
		const one: Pick<ActivityCard, "liveLanes"> = { liveLanes: ["docs"] };
		const two: Pick<ActivityCard, "liveLanes"> = {
			liveLanes: ["docs", "arch"],
		};
		expect(Cockpit.nowOverLog(one, true, "docs")).toBe(false);
		expect(Cockpit.nowOverLog(one, true, "functional")).toBe(true);
		expect(Cockpit.nowOverLog(two, true, "docs")).toBe(true);
		// A finished run's "now" is its trace, which the log never repeats.
		expect(Cockpit.nowOverLog(one, false, "docs")).toBe(true);
	});

	it("gives now over a log half the column, between 5 and 16 rows", () => {
		expect(Cockpit.nowCap(45)).toBe(16);
		expect(Cockpit.nowCap(20)).toBe(10);
		expect(Cockpit.nowCap(6)).toBe(5);
	});

	it("packs whole facts into rows", () => {
		const facts = [
			{ label: "slots", value: "2/2" },
			{ label: "continuations", value: "0/3" },
			{ label: "lenses", value: "functional·quality" },
		];
		expect(
			Cockpit.factRows(facts, 30).map((row) => row.map((f) => f.label)),
		).toEqual([["slots", "continuations"], ["lenses"]]);
	});
});

describe("the footer keeps the bottom rows", () => {
	const story = (name: string) => {
		const found = STORIES.find((one) => one.name === name);
		if (!found) throw new Error(`no story ${name}`);
		return found;
	};

	for (const [name, width, height] of [
		["run-map-short", 100, 22],
		["run-map-short", 100, 16],
		["cockpit-finished", 160, 22],
		["cockpit-live", 200, 50],
	] as const)
		it(`${name} at ${width}×${height}`, async () => {
			const { renderOnce, captureCharFrame, destroy } = await renderTest(
				story(name).render(),
				{ width, height },
			);
			try {
				const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
					/now|run trace/.test(f),
				);
				const rows = frame.split("\n");
				expect(rows[height - 2]).toContain("tab to ask the copilot");
				expect(rows[height - 1]).toContain("? help");
			} finally {
				destroy();
			}
		});
});
