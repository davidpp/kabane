/** @jsxImportSource @opentui/react */
// An agent's decisions answered on the board against a real tracker: `u` narrows the board to the
// issues waiting on them, a detail asks them one at a time with the copilot form's keys, and the
// last answer hands the issue back to `next` through `Questions.answer`, as `kabane_answer` would.
// Back on the narrowed board the next issue is in hand; a typed answer started over is gone, and one
// whose write fails is asked again.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, withDb } from "@cabane/core";
import { Questions } from "@cabane/questions";
import { App } from "./app";
import { BoardNav } from "./nav";
import { noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `cabane-board-decisions-${crypto.randomUUID()}`);
const AGENT = "cabane://actor/agent/claude";

let issueId = "";
let scopeId = "";

beforeAll(async () => {
	await freshDb(BASE);
	const other = await Planner.addTask(BASE, {
		title: "Unrelated cleanup",
		kind: "issue",
		state: "next",
	});
	if (!other.ok) throw other.error;
	// Filed before the first, so it lists under it in the waiting section (newest first).
	const scope = await Planner.addTask(BASE, {
		title: "Name the scope",
		kind: "issue",
		state: "in_progress",
	});
	if (!scope.ok) throw scope.error;
	scopeId = scope.value.id;
	const named = await Questions.ask(
		BASE,
		{
			id: scopeId,
			questions: [{ question: "What should the scope be called?" }],
		},
		AGENT,
	);
	if (!named.ok) throw named.error;
	const issue = await Planner.addTask(BASE, {
		title: "Cache the session tokens",
		kind: "issue",
		state: "in_progress",
	});
	if (!issue.ok) throw issue.error;
	issueId = issue.value.id;
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
				{
					question: "Which checks gate a merge?",
					choices: ["Lint", "Types", "Tests"],
					multiSelect: true,
					allowFreeform: true,
				},
			],
		},
		AGENT,
	);
	if (!asked.ok) throw asked.error;
});

afterAll(() => dropDb(BASE));

it("u finds the issue, its detail asks both decisions, and the last answer moves it to next", async () => {
	let now = 0;
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App cwd={BASE} basePath={BASE} activity={noActivity} clock={() => now} />,
		{ width: 100, height: 34 },
	);
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	// Each question, and each field of it, is held until it has been on screen to read.
	const read = async (p: (f: string) => boolean): Promise<string> => {
		const frame = await until(p);
		now += BoardNav.ARM_MS;
		return frame;
	};
	try {
		const board = await until((f) => f.includes("?2"));
		expect(board).toContain("Unrelated cleanup");
		expect(board).toContain("u decisions");
		mockInput.pressKey("u");
		const narrowed = await until((f) => f.includes("· decisions"));
		expect(narrowed).not.toContain("Unrelated cleanup");
		mockInput.pressEnter();
		const asked = await read((f) => f.includes("waiting on you"));
		expect(asked).toContain("claude asks");
		expect(asked).toContain("1 SQLite ★");
		expect(asked).toContain("1 more waiting");
		mockInput.pressKey("1");
		const reasoning = await read((f) => f.includes("Reasoning"));
		// Every key but esc and tab is typed into the field: the footer offers no other.
		expect(reasoning).not.toContain("h/l sections");
		expect(reasoning).toContain("enter send · esc start over · tab next pane");
		await mockInput.typeText("local first");
		mockInput.pressEnter();
		await read((f) => f.includes("Which checks gate a merge?"));
		mockInput.pressKey("1");
		mockInput.pressKey("3");
		await until((f) => f.includes("enter send (2 picked)"));
		mockInput.pressEnter();
		await read((f) => f.includes("Other"));
		mockInput.pressEnter();
		await read((f) => f.includes("Reasoning · 3 of 3"));
		mockInput.pressEnter();
		const done = await until((f) => f.includes("→ next"));
		expect(done).toContain(":2 answered · ");
		expect(done).toContain("Which store should hold the tokens? → SQLite (");
		const issue = await Planner.getTask(BASE, issueId);
		expect(issue.ok && issue.value?.state).toBe("next");
		const rows = await Questions.list(BASE, { id: issueId });
		if (!rows.ok) throw rows.error;
		expect(rows.value.map((row) => [row.answer, row.reasoning])).toEqual([
			["SQLite", "local first"],
			["Lint, Tests", undefined],
		]);

		// Its last decision answered, the issue leaves the narrowed board, and the one still waiting
		// is in hand: enter opens it.
		mockInput.pressEscape();
		const back = await until(
			(f) => f.includes("· decisions") && !f.includes("[copy]"),
		);
		expect(back).not.toContain("Cache the session tokens");
		mockInput.pressEnter();
		await read((f) => f.includes("What should the scope be called?"));
		expect(captureCharFrame()).toContain("enter to answer");

		// Started over, what was typed goes with it.
		// The input takes the keys once a render has focused it.
		mockInput.pressEnter();
		await until((f) => f.includes("esc start over"));
		await mockInput.typeText("draft name");
		await until((f) => f.includes("draft name"));
		mockInput.pressEscape();
		const over = await until((f) => f.includes("enter to answer"));
		expect(over).not.toContain("draft name");

		// The question went away under the board (another device): the write fails, and the
		// decision is asked again.
		mockInput.pressEnter();
		await until((f) => f.includes("esc start over"));
		await mockInput.typeText("kabane");
		mockInput.pressEnter();
		await read((f) => f.includes("Reasoning · 2 of 2"));
		await withDb(BASE, (db) =>
			db.run("DELETE FROM task_questions WHERE task_id = ?", [scopeId]),
		);
		mockInput.pressEnter();
		const failed = await until((f) => f.includes("No question found"));
		expect(failed).toContain("What should the scope be called?");
		expect(failed).toContain("enter to answer");
	} finally {
		destroy();
	}
});
