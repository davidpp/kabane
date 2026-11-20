/** @jsxImportSource @opentui/react */
// The board reads and answers through the ActivitySource a host hands it, over a real tracker.
// `!` lands on the owning card and a digit reaches the source once the question has been read.
// The board cannot import the loop, so the source here is a recording of the port contract: it
// lists one question until it is answered, and records every call the board makes. The real
// store behind the port, which stamps the acting human on the answer (the port carries no actor),
// is covered by `extensions/loop/src/activity.test.ts`, "lists only loop questions with their
// card and lane, and answers through the port" (`LoopActivity.source`).
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner, type Task } from "@kabane/core";
import type { ActivityCard, ActivitySource } from "@kabane/extension";
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
	type Call =
		| { call: "questions" }
		| { call: "answer"; questionId: string; answer: string };
	const calls: Call[] = [];
	const answers = () => calls.filter((c) => c.call === "answer");
	const askedAt = new Date().toISOString();
	const source: ActivitySource = {
		load: async () => ok([card]),
		card: async () => ok(card),
		events: async () => ok([]),
		questions: async () => {
			calls.push({ call: "questions" });
			return ok(
				answers().length > 0 || !child
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
			);
		},
		answer: async (questionId, answer) => {
			calls.push({ call: "answer", questionId, answer });
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
		expect(answers()).toEqual([]);
		now += BoardNav.ARM_MS;
		mockInput.pressKey("1");
		const answered = await until((f) => f.includes("answered Yes"));
		expect(
			answered
				.split("\n")
				.find((row) => row.includes("answered Yes"))
				?.trim(),
		).toBe("answered Yes");
		// Answered once, with the question's id and the chosen option's label.
		expect(answers()).toEqual([
			{ call: "answer", questionId: QUESTION_ID, answer: "Yes" },
		]);
		// Then the board reads the questions again, and the answered one is gone from it.
		const answeredAt = calls.findIndex((c) => c.call === "answer");
		const cleared = await until(
			(f) =>
				calls.slice(answeredAt + 1).some((c) => c.call === "questions") &&
				!f.includes("?1"),
		);
		expect(
			calls.slice(answeredAt + 1).some((c) => c.call === "questions"),
		).toBe(true);
		expect(cleared).not.toContain("?1");
	} finally {
		destroy();
	}
});
