/** @jsxImportSource @opentui/react */
// An issue's `now` opens at its top in the real board, against a real tracker: the first block's
// header is the first row under the section bar, however far down the `J/K` cursor starts. The
// cursor on a link under a long handoff once scrolled the handoff's header and opening off screen
// as the detail opened (JCAB-652).
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checklist } from "@kabane/checklist";
import { Planner } from "@kabane/core";
import { Questions } from "@kabane/questions";
import { App } from "./app";
import { noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `kabane-board-now-top-${crypto.randomUUID()}`);

let issueId = "";
let longListId = "";
let oneLinkId = "";

beforeAll(async () => {
	await freshDb(BASE);
	const issue = await Planner.addTask(BASE, {
		title: "Long handoff",
		kind: "issue",
		state: "in_progress",
	});
	if (!issue.ok) throw issue.error;
	issueId = issue.value.id;
	const related = await Planner.addTask(BASE, {
		title: "Related work",
		kind: "issue",
		state: "next",
	});
	if (!related.ok) throw related.error;
	const linked = await Planner.addLink(BASE, {
		sourceId: issueId,
		targetId: related.value.id,
		type: "related",
	});
	if (!linked.ok) throw linked.error;
	const evidence = Array.from(
		{ length: 30 },
		(_, n) => `- check ${n + 1} passed`,
	);
	const handed = await Planner.addEntry(BASE, {
		taskId: issueId,
		kind: "handoff",
		author: "kabane://actor/agent/claude",
		authorType: "ai",
		content: [
			"## Summary",
			"",
			"Opening line.",
			"",
			"## Evidence",
			"",
			...evidence,
		].join("\n"),
	});
	if (!handed.ok) throw handed.error;
	// An open decision asked over the sections, as on JCAB-652, leaves `now` fewer rows.
	const asked = await Questions.ask(
		BASE,
		{
			id: issueId,
			questions: [
				{
					question: "Which store should hold the tokens?",
					choices: ["SQLite", "Redis"],
					recommended: "SQLite",
				},
			],
		},
		"kabane://actor/agent/claude",
	);
	if (!asked.ok) throw asked.error;

	// Twenty-five items, only the last open: the cursor starts on it, below the fold at 40×30.
	const longList = await Planner.addTask(BASE, {
		title: "Long checklist",
		kind: "issue",
		state: "in_progress",
	});
	if (!longList.ok) throw longList.error;
	longListId = longList.value.id;
	const items = await Checklist.add(BASE, {
		id: longListId,
		items: Array.from({ length: 25 }, (_, n) => `step ${n + 1}`),
	});
	if (!items.ok) throw items.error;
	const ticked = await Checklist.tick(BASE, {
		items: items.value.items.slice(0, 24).map((item) => `id:${item.id}`),
	});
	if (!ticked.ok) throw ticked.error;

	// A long handoff over a single link: the cursor starts on the link, with no row to move to.
	const oneLink = await Planner.addTask(BASE, {
		title: "One link",
		kind: "issue",
		state: "in_progress",
	});
	if (!oneLink.ok) throw oneLink.error;
	oneLinkId = oneLink.value.id;
	const linkedOnce = await Planner.addLink(BASE, {
		sourceId: oneLinkId,
		targetId: related.value.id,
		type: "related",
	});
	if (!linkedOnce.ok) throw linkedOnce.error;
	const handedOnce = await Planner.addEntry(BASE, {
		taskId: oneLinkId,
		kind: "handoff",
		author: "kabane://actor/agent/claude",
		authorType: "ai",
		content: ["## Evidence", "", ...evidence].join("\n"),
	});
	if (!handedOnce.ok) throw handedOnce.error;
});

afterAll(() => dropDb(BASE));

it("opens now with its first block's header on the first row under the section bar", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<App
			cwd={BASE}
			basePath={BASE}
			activity={noActivity}
			open={{ taskId: issueId }}
		/>,
		{ width: 40, height: 30 },
	);
	try {
		await pumpUntil(
			renderOnce,
			captureCharFrame,
			(f) => f.includes("Which store") && f.includes(" now "),
		);
		// A frame more, for any scroll the opening asks for to land.
		await renderOnce();
		const frame = captureCharFrame();
		const lines = frame.split("\n");
		const bar = lines.findIndex((row) => row.includes(" now "));
		expect(bar).toBeGreaterThan(-1);
		// The bar, a blank row, then the first block's header.
		expect(lines[bar + 2]).toStartWith(" handoff · claude · just now");
		expect(frame).toContain("Opening line.");
	} finally {
		destroy();
	}
});

// Open the issue at 40×30, wait for `now`, press `key`, and give back the frame after it.
const pressOn = async (
	taskId: string,
	ready: string,
	key: string,
): Promise<string> => {
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App cwd={BASE} basePath={BASE} activity={noActivity} open={{ taskId }} />,
		{ width: 40, height: 30 },
	);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) => f.includes(ready));
		await renderOnce();
		mockInput.pressKey(key);
		await renderOnce();
		await renderOnce();
		return captureCharFrame();
	} finally {
		destroy();
	}
};

it("J with no row below still brings the cursor's row into view", async () => {
	// Opened at its top, the open item is below the fold until a key asks for it.
	const frame = await pressOn(longListId, "checklist · 24/25", "J");
	expect(frame).toContain("○ step 25");
});

it("J and K on the only row under a long handoff bring it into view", async () => {
	for (const key of ["J", "K"]) {
		const frame = await pressOn(oneLinkId, "handoff · claude", key);
		expect({ key, shown: frame.includes("Related work") }).toEqual({
			key,
			shown: true,
		});
	}
});
