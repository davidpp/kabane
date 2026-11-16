/** @jsxImportSource @opentui/react */
// The board reads and answers through the ActivitySource a host hands it, over a real tracker.
// `!` lands on the owning card and a digit reaches the source once the question has been read.
// The question lives where its asker keeps it (the loop's own store, in the CLI); here the source
// holds it, since the port is all the board sees of it.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner, type Task } from "@cabane/core";
import type { ActivityCard, ActivitySource } from "@cabane/extension";
import { App } from "./app";
import { BoardNav } from "./nav";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `cabane-board-answer-${crypto.randomUUID()}`);

const QUESTION_ID = "loop:q-1";
let child: Task | undefined;

beforeAll(async () => {
	await freshDb(BASE);
	const parent = await Planner.addTask(BASE, {
		title: "Parent",
		kind: "issue",
		state: "in_progress",
	});
	if (!parent.ok) throw parent.error;
	const asked = await Planner.addTask(BASE, {
		title: "Child",
		kind: "issue",
		state: "in_progress",
		parentTaskId: parent.value.id,
	});
	if (!asked.ok) throw asked.error;
	child = asked.value;
});

afterAll(() => dropDb(BASE));

it("! lands on the card's tab and a digit there answers the question through the port, once it has been read", async () => {
	const card: ActivityCard = {
		id: "run-1",
		kind: "loops",
		label: "loop",
		status: "running",
		startedAt: new Date().toISOString(),
		detail: [],
		hasEvents: true,
		tab: true,
	};
	const answers: { id: string; answer: string }[] = [];
	const askedAt = new Date().toISOString();
	const source: ActivitySource = {
		load: async () => ok([card]),
		card: async () => ok(card),
		events: async () => ok([]),
		questions: async () =>
			ok(
				answers.length > 0 || !child
					? []
					: [
							{
								id: QUESTION_ID,
								cardId: card.id,
								taskId: child.id,
								taskShortId: child.shortId ?? child.id,
								question: "claude asks to run: bun install",
								choices: ["Yes", "No"],
								multiSelect: false,
								allowFreeform: false,
								permission: true,
								asker: "claude",
								askedAt,
							},
						],
			),
		answer: async (id, answer) => {
			answers.push({ id, answer });
			return ok(`answered ${answer}`);
		},
	};
	let now = 0;
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App cwd={BASE} basePath={BASE} activity={source} clock={() => now} />,
		{ width: 100, height: 24 },
	);
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	try {
		await until((f) => f.includes("Parent") && f.includes("?1"));
		mockInput.pressKey("!");
		const onTab = await until((f) => f.includes("waiting on you"));
		expect(onTab).toContain("1 Yes · 2 No");
		expect(onTab).toContain("1-9 answer");
		// Landed this instant: a digit pressed now was not aimed at a question read on screen.
		mockInput.pressKey("1");
		await until((f) => f.includes("just asked"));
		expect(answers).toEqual([]);
		now += BoardNav.ARM_MS;
		mockInput.pressKey("1");
		const answered = await until((f) => f.includes("answered Yes"));
		expect(
			answered
				.split("\n")
				.find((row) => row.includes("answered Yes"))
				?.trim(),
		).toBe("answered Yes");
		expect(answers).toEqual([{ id: QUESTION_ID, answer: "Yes" }]);
	} finally {
		destroy();
	}
});
