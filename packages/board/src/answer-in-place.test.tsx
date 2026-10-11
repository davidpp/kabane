/** @jsxImportSource @opentui/react */
// A question a tabbed card's session asked, answered from the card's tab against a real tracker:
// `!` lands on the tab, a digit writes the decision through `Planner.answerQuestion`, and the host
// hears who answered first. The host is the smallest ActivitySource that lists one tabbed card.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatQuestionBody, isAnswerTo, ok, Planner } from "@cabane/core";
import { App } from "./app";
import type { ActivityCard, ActivitySource } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `cabane-board-answer-${crypto.randomUUID()}`);

let sessionId = "";
let questionId = "";

beforeAll(async () => {
	await freshDb(BASE);
	const parent = await Planner.addTask(BASE, {
		title: "Parent",
		kind: "issue",
		state: "in_progress",
	});
	if (!parent.ok) throw parent.error;
	const child = await Planner.addTask(BASE, {
		title: "Child",
		kind: "issue",
		state: "in_progress",
		parentTaskId: parent.value.id,
	});
	if (!child.ok) throw child.error;
	const session = await Planner.startSession(BASE, {
		taskId: child.value.id,
		agent: "claude",
	});
	if (!session.ok) throw session.error;
	sessionId = session.value.id;
	const question = await Planner.addActivity(BASE, {
		sessionId,
		type: "question",
		body: formatQuestionBody("claude asks to run: bun install", {
			choices: ["Yes", "No"],
			multiSelect: false,
			allowFreeform: false,
		}),
	});
	if (!question.ok) throw question.error;
	questionId = question.value.id;
});

afterAll(() => dropDb(BASE));

it("! lands on the card's tab and a digit there answers the question in core", async () => {
	const card: ActivityCard = {
		id: "run-1",
		kind: "loops",
		label: "loop",
		status: "running",
		startedAt: new Date().toISOString(),
		detail: [],
		hasEvents: true,
		tab: true,
		sessionIds: [sessionId],
	};
	const noted: string[] = [];
	const source: ActivitySource = {
		load: async () => ok([card]),
		card: async () => ok(card),
		events: async () => ok([]),
		answering: async (id) => {
			noted.push(id);
			return ok(undefined);
		},
	};
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App cwd={BASE} basePath={BASE} activity={source} />,
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
		mockInput.pressKey("1");
		await until((f) => f.includes("answered Yes"));
		const activities = await Planner.getActivities(BASE, sessionId);
		if (!activities.ok) throw activities.error;
		const decision = activities.value.find(
			(a) => a.type === "decision" && isAnswerTo(a.context, questionId),
		);
		expect(decision?.body).toBe("Yes");
		expect(noted).toEqual([questionId]);
		const needs = await Planner.getNeedsInput(BASE);
		expect(needs.ok && needs.value).toEqual([]);
	} finally {
		destroy();
	}
});
