/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { ActivityCard } from "./ports";
import { TabBar } from "./tab-bar";
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
