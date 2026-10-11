/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { ActivityCard } from "./ports";
import { CardTabQuestion, TabBar } from "./tab-bar";
import { BoardTabs } from "./tabs";
import { pumpUntil, renderTest } from "./testing";

const loop = (n: number): ActivityCard => ({
	id: `loop:r${n}`,
	kind: "loops",
	label: "loop",
	status: "completed",
	taskShortId: `JREP-${n}`,
	startedAt: `2026-10-10T00:0${n}:00.000Z`,
	detail: [],
	hasEvents: true,
	tab: true,
	sessionIds: [`s${n}`],
});

const frameOf = async (
	tabs: BoardTabs.Tabs,
	cards: readonly ActivityCard[],
	width: number,
): Promise<string> => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<TabBar tabs={tabs} cards={cards} spinnerFrame="⠋" />,
		{ width, height: 2 },
	);
	try {
		return await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("tracker"),
		);
	} finally {
		destroy();
	}
};

test("a bar too wide for the pane keeps the tracker, the tab on screen and the ones waiting", async () => {
	const cards = [1, 2, 3, 4, 5, 6].map(loop);
	const tabs: BoardTabs.Tabs = {
		...BoardTabs.NONE,
		open: cards.map((card) => card.id),
		active: "loop:r6",
		cards: new Map(
			cards.map((card) => [
				card.id,
				{ finished: true, sessionIds: card.sessionIds ?? [] },
			]),
		),
		queue: [
			{
				taskId: "t2",
				taskShortId: "JREP-2",
				sessionId: "s2",
				questionActivityId: "q2",
				question: "LRU or TTL?",
				choices: ["LRU", "TTL"],
				agent: "claude",
				askedAt: "2026-10-10T00:10:00.000Z",
			},
		],
	};
	const line = (await frameOf(tabs, cards, 60)).split("\n")[0] ?? "";
	expect(line).toContain("tracker ?1");
	expect(line).toContain("JREP-2 ?1");
	expect(line).toContain("7 ✓ JREP-6");
	expect(line).toMatch(/\+\d /);
	expect(line.trimEnd().length).toBeLessThanOrEqual(60);
	// With the room, every tab and no count.
	const wide = (await frameOf(tabs, cards, 120)).split("\n")[0] ?? "";
	expect(wide).toContain("JREP-4");
	expect(wide).not.toMatch(/\+\d /);
});

const asked = (n: number, choices: string[]): BoardTabs.Question => ({
	taskId: `t${n}`,
	taskShortId: `JREP-${n}`,
	sessionId: "s1",
	questionActivityId: `q${n}`,
	question: `Install dependencies ${n}?`,
	choices,
	agent: "claude",
	askedAt: `2026-10-10T00:0${n}:00.000Z`,
});

const questionFrame = async (tabs: BoardTabs.Tabs): Promise<string> => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<CardTabQuestion tabs={tabs} onAnswer={() => {}} />,
		{ width: 80, height: 6 },
	);
	try {
		return await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("asks about"),
		);
	} finally {
		destroy();
	}
};

test("a card's tab pins its oldest question answerable, counts the rest, and says what was answered", async () => {
	const card = loop(1);
	const tabs: BoardTabs.Tabs = {
		...BoardTabs.NONE,
		open: [card.id],
		active: card.id,
		cards: new Map([[card.id, { finished: false, sessionIds: ["s1"] }]]),
		queue: [asked(2, ["Yes", "No"]), asked(3, ["Yes", "No"])],
	};
	const waiting = await questionFrame(tabs);
	expect(waiting).toContain(
		"waiting on you · claude asks about JREP-2 · +1 more",
	);
	expect(waiting).toContain("1 Yes · 2 No");
	expect(waiting).not.toContain("answer it over");
	const answered = await questionFrame({
		...tabs,
		answered: new Map([["q2", "No"]]),
	});
	expect(answered).toContain("✓ answered");
	expect(answered).toContain("→ No");
	expect(answered).not.toContain("1 Yes");
});
