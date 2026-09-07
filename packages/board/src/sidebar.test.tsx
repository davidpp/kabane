/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { BoardActivity } from "./activity";
import type { ActivityCard } from "./ports";
import {
	buildSidebarItems,
	cardRowText,
	groupCards,
	Sidebar,
	sidebarWidth,
} from "./sidebar";
import { renderTest } from "./testing";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const pumpUntil = async (
	renderOnce: () => Promise<void>,
	captureCharFrame: () => string,
	predicate: (frame: string) => boolean,
): Promise<string> => {
	let frame = "";
	for (let pass = 0; pass < 40; pass++) {
		await renderOnce();
		frame = captureCharFrame();
		if (predicate(frame)) break;
		await sleep(20);
	}
	return frame;
};

const card = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "r1",
	kind: "runs",
	label: "scout",
	status: "running",
	taskId: "t1",
	startedAt: new Date(Date.now() - 5000).toISOString(),
	detail: [],
	...over,
});

const resolve = (taskId: string): string | undefined =>
	taskId === "t1" ? "JAKE-1" : undefined;

test("groupCards keeps kinds in first-seen order and cards in source order", () => {
	const groups = groupCards([
		card({ id: "a", kind: "runs" }),
		card({ id: "b", kind: "loops", label: "loop" }),
		card({ id: "c", kind: "runs", status: "completed" }),
	]);
	expect(groups.map((g) => g.kind)).toEqual(["runs", "loops"]);
	expect(groups[0]?.cards.map((c) => c.id)).toEqual(["a", "c"]);
});

test("buildSidebarItems lists cards by kind group, then questions, in render order", () => {
	const activity = BoardActivity.indexCards([
		card({ id: "a" }),
		card({
			id: "b",
			kind: "loops",
			label: "loop",
			taskId: undefined,
			taskShortId: "JAKE-2",
		}),
	]);
	activity.questionsByTaskId.set("t1", [
		{
			taskId: "t1",
			sessionId: "s",
			questionActivityId: "q",
			question: "Which?",
		},
	]);
	const items = buildSidebarItems(activity);
	expect(items.map((i) => (i.type === "card" ? i.card.id : "input"))).toEqual([
		"a",
		"b",
		"input",
	]);
});

test("cardRowText shows glyph, label, task label, then detail lines or elapsed time", () => {
	expect(
		cardRowText(card({ detail: ["implement", "$0.42"] }), "⠹", resolve),
	).toBe("⠹ scout · JAKE-1 · implement · $0.42");
	expect(
		cardRowText(
			card({ status: "completed", finishedAt: new Date().toISOString() }),
			"⠹",
			resolve,
		),
	).toMatch(/^• scout · JAKE-1 · \d+s$/);
	expect(
		cardRowText(
			card({ taskId: undefined, taskShortId: "JAKE-9", status: "failed" }),
			"⠹",
			resolve,
		),
	).toMatch(/^✗ scout · JAKE-9 · /);
	expect(cardRowText(card({ stale: true }), "⠹", resolve).startsWith("⠋")).toBe(
		true,
	);
});

test("Sidebar renders one titled section per kind, the input section, and 'no activity' when empty", async () => {
	const activity = BoardActivity.indexCards([
		card({ id: "a" }),
		card({
			id: "b",
			kind: "loops",
			label: "loop",
			taskId: undefined,
			taskShortId: "JAKE-2",
			detail: ["verify 2"],
		}),
	]);
	activity.questionsByTaskId.set("t1", [
		{
			taskId: "t1",
			sessionId: "s",
			questionActivityId: "q",
			question: "Which auth flow?",
		},
	]);
	const full = await renderTest(
		<Sidebar
			activity={activity}
			sidebarWidth={44}
			focused={true}
			selectedIndex={1}
			spinnerFrame="⠹"
			resolveShortId={resolve}
		/>,
		{ width: 44, height: 20 },
	);
	try {
		const frame = await pumpUntil(full.renderOnce, full.captureCharFrame, (f) =>
			f.includes("input needed"),
		);
		expect(frame).toContain("runs");
		expect(frame).toContain("⠹ scout · JAKE-1");
		expect(frame).toContain("loops");
		// The focused, selected row carries the `> ` gutter.
		expect(frame).toContain("> ⠹ loop · JAKE-2 · verify 2");
		expect(frame).toContain("input needed");
		expect(frame).toContain("? JAKE-1 · Which auth flow?");
	} finally {
		full.destroy();
	}

	const empty = await renderTest(
		<Sidebar
			activity={BoardActivity.emptyActivity()}
			sidebarWidth={30}
			focused={false}
			selectedIndex={0}
			spinnerFrame="⠹"
			resolveShortId={resolve}
		/>,
		{ width: 30, height: 5 },
	);
	try {
		const frame = await pumpUntil(
			empty.renderOnce,
			empty.captureCharFrame,
			(f) => f.includes("no activity"),
		);
		expect(frame).toContain("no activity");
	} finally {
		empty.destroy();
	}
});

test("sidebarWidth clamps to [28, 44] at a quarter of the terminal", () => {
	expect(sidebarWidth(80)).toBe(28);
	expect(sidebarWidth(140)).toBe(35);
	expect(sidebarWidth(400)).toBe(44);
});
