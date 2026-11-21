/** @jsxImportSource @opentui/react */
// The cockpit's arrangement: where the tab splits, whose log its right column follows, how many rows
// "now" takes over a log, how the run's facts pack, and that the footer keeps the bottom rows of the
// gallery's run tabs, stacked and split.
import { describe, expect, it } from "bun:test";
import type { ActivityCard, ActivityStep } from "@kabane/extension";
import { Cockpit } from "./cockpit";
import { RunMapView } from "./run-map-view";
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

	it("gives up a question's blank rows first, then its question's rows", () => {
		const parts = { header: 2, question: 3, answers: 1 };
		// Room for everything, and the map above has all it wants.
		expect(Cockpit.bannerFit(parts, 20, 20)).toEqual({ gaps: 3, question: 3 });
		// The map wants rows: the blank rows go before the map's.
		expect(Cockpit.bannerFit(parts, 20, 7)).toEqual({ gaps: 1, question: 3 });
		expect(Cockpit.bannerFit(parts, 6, 6)).toEqual({ gaps: 0, question: 3 });
		// Then the question, down to one row; who asks and the answers stay.
		expect(Cockpit.bannerFit(parts, 4, 4)).toEqual({ gaps: 0, question: 1 });
		expect(Cockpit.bannerFit(parts, 2, 2)).toEqual({ gaps: 0, question: 1 });
	});

	it("counts wrapped rows", () => {
		expect(Cockpit.wrapRows("waiting on you · docs asks", 40)).toBe(1);
		expect(
			Cockpit.wrapRows("? Run `bun run docs:check` in the worktree?", 38),
		).toBe(2);
		expect(Cockpit.wrapRows("one\ntwo", 40)).toBe(2);
		expect(Cockpit.wrapRows("x".repeat(25), 10)).toBe(3);
		expect(Cockpit.cellRows(["1 Allow once", " · 2 Reject"], 38)).toBe(1);
		expect(Cockpit.cellRows(["1 Allow once", " · 2 Reject"], 15)).toBe(2);
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

// "Now"'s rows under the title, read from its column: each one a tagged line of NOW_EVENTS.
const nowEvents = (frame: string, from: number): number => {
	const rows = frame.split("\n").map((row) => row.slice(from).trimStart());
	const title = rows.findIndex((row) => row.startsWith("now"));
	if (title === -1) return 0;
	let count = 0;
	for (const row of rows.slice(title + 1)) {
		if (!/^(\d\d:\d\d )?(docs|arch) /.test(row)) break;
		count++;
	}
	return count;
};

describe("a question on a short pane leaves now five rows", () => {
	const live = STORIES.find((one) => one.name === "cockpit-live");
	for (const [width, height] of [
		[40, 16],
		[159, 16],
		[160, 18],
		[200, 50],
	] as const)
		it(`at ${width}×${height}`, async () => {
			if (!live) throw new Error("no cockpit-live story");
			const { renderOnce, captureCharFrame, destroy } = await renderTest(
				live.render(),
				{ width, height },
			);
			try {
				const from = width >= Cockpit.SPLIT_COLS ? Cockpit.LEFT_COLS : 0;
				const frame = await pumpUntil(
					renderOnce,
					captureCharFrame,
					(f) => nowEvents(f, from) >= Cockpit.NOW_MIN_ROWS,
				);
				const rows = frame.split("\n");
				// The question is still there, its answers included.
				expect(frame).toContain("1 Allow once");
				expect(rows[height - 1]).toContain("? help");
			} finally {
				destroy();
			}
		});
});

describe("what a finished card left counts as seen", () => {
	const FINISHED = {
		steps: [
			"implement",
			"gates",
			"triage",
			"review",
			"fixer",
			"recheck",
			"land",
		].map((name): ActivityStep => ({ name, state: "done" })),
		left: [
			{ taskId: "01F1", taskShortId: "PROJ-22", how: "filed by docs" },
			{ how: "branch proj-5", reason: "land: none" },
		],
	};

	const seen = async (maxRows: number): Promise<[number, string]> => {
		let reports = 0;
		const { renderOnce, captureCharFrame, destroy } = await renderTest(
			<RunMapView
				card={FINISHED}
				view={{}}
				asking={new Set()}
				width={100}
				maxRows={maxRows}
				spinnerFrame="⠋"
				onLeftShown={() => reports++}
			/>,
			{ width: 100, height: 30 },
		);
		try {
			const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
				f.includes("implement"),
			);
			await renderOnce();
			return [reports, frame];
		} finally {
			destroy();
		}
	};

	it("not while the window leaves the list out", async () => {
		const [reports, frame] = await seen(4);
		expect(frame).toContain("more");
		expect(frame).not.toContain("PROJ-22");
		expect(reports).toBe(0);
	});

	it("once the window shows it, reported once", async () => {
		const [reports, frame] = await seen(20);
		expect(frame).toContain("PROJ-22");
		expect(reports).toBe(1);
	});
});
