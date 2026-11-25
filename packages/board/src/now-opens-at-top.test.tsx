/** @jsxImportSource @opentui/react */
// An issue's `now` opens at its top in the real board, against a real tracker: the first block's
// header is the first row under the section bar, however far down the `J/K` cursor starts. The
// cursor on a link under a long handoff once scrolled the handoff's header and opening off screen
// as the detail opened (JCAB-652).
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@kabane/core";
import { Questions } from "@kabane/questions";
import { App } from "./app";
import { noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `kabane-board-now-top-${crypto.randomUUID()}`);

let issueId = "";

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
