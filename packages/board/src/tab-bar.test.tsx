/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import type { ActivityCard } from "./ports";
import { CardTabQuestion, PinnedQuestion, TabBar } from "./tab-bar";
import { BoardTabs } from "./tabs";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

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
				multiSelect: false,
				allowFreeform: false,
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
	multiSelect: false,
	allowFreeform: choices.length === 0,
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

test("a multi-select question shows what is toggled and that enter sends the picks", async () => {
	const card = loop(1);
	const question = {
		...asked(2, ["Alpha", "Beta", "decline"]),
		multiSelect: true,
	};
	const frame = await questionFrame({
		...BoardTabs.NONE,
		open: [card.id],
		active: card.id,
		cards: new Map([[card.id, { finished: false, sessionIds: ["s1"] }]]),
		queue: [question],
		picked: new Map([["q2", [1]]]),
	});
	expect(frame).toContain(
		"1 [ ] Alpha · 2 [x] Beta · 3 [ ] decline · enter send the picks",
	);
});

test("a question's answers read as content: each key and its words in the text color, the separators muted", async () => {
	const T = Theme.DARK;
	const rgb = (hex: string): number[] => RGBA.fromHex(hex).toInts().slice(0, 3);
	const card = loop(1);
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<CardTabQuestion
				tabs={{
					...BoardTabs.NONE,
					open: [card.id],
					active: card.id,
					cards: new Map([[card.id, { finished: false, sessionIds: ["s1"] }]]),
					queue: [{ ...asked(2, ["Alpha", "Beta"]), multiSelect: true }],
					picked: new Map([["q2", [1]]]),
				}}
				onAnswer={() => {}}
			/>,
			{ width: 80, height: 8 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) => f.includes("Beta"));
		const spans = captureSpans().lines.flatMap((line) => line.spans);
		const fgOf = (text: string) =>
			spans
				.find((span) => span.text.includes(text))
				?.fg.toInts()
				.slice(0, 3);
		expect(fgOf("Alpha")).toEqual(rgb(T.text));
		expect(fgOf("Beta")).toEqual(rgb(T.text));
		expect(fgOf("1 ")).toEqual(rgb(T.text));
		expect(fgOf(" · ")).toEqual(rgb(T.muted));
		expect(fgOf("[x]")).toEqual(rgb(T.accent));
		expect(fgOf("[ ]")).toEqual(rgb(T.muted));
	} finally {
		destroy();
	}
});

test("a pinned question that left the queue without this board's answer reads as closed, not answered", async () => {
	const question = asked(2, ["Yes", "No"]);
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<PinnedQuestion
				tabs={BoardTabs.NONE}
				banner={{ question }}
				cards={[]}
				onAnswer={() => {}}
			/>,
			{ width: 80, height: 6 },
		);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("asks about"),
		);
		expect(frame).toContain("closed · claude asks about JREP-2");
		// A blank row of the banner's own surface above and below, as the copilot's ask panel has.
		const rows = frame.split("\n").map((row) => row.trim());
		const raised = RGBA.fromHex(Theme.DARK.surface.raised).toInts().join();
		const surfaceOf = (at: number) =>
			captureSpans().lines[at]?.spans[0]?.bg.toInts().join();
		expect([rows[0], rows[3]]).toEqual(["", ""]);
		expect([surfaceOf(0), surfaceOf(3)]).toEqual([raised, raised]);
		expect(surfaceOf(4)).not.toBe(raised);
		expect(rows[1]).toStartWith("closed");
		expect(frame).not.toContain("✓ answered");
		expect(frame).not.toContain("1 Yes");
	} finally {
		destroy();
	}
});
