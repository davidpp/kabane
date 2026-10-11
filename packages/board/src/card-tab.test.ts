// A card's own tab through the same reducer the keyboard and the mouse drive: its lanes.
import { describe, expect, it } from "bun:test";
import { CardTab } from "./card-tab";
import { BoardNav } from "./nav";
import type { ActivityCard } from "./ports";
import { BoardTabs } from "./tabs";

const card = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "loop:r1",
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "JREP-1",
	startedAt: "2026-10-10T00:00:00.000Z",
	detail: [],
	hasEvents: true,
	tab: true,
	lanes: ["claude:JREP-2", "claude:JREP-3"],
	laneNoun: "agents",
	...over,
});

const key = (name: string): BoardNav.KeyInput => ({ name, sequence: name });

const press = (
	state: BoardNav.BoardState,
	...names: string[]
): { state: BoardNav.BoardState; effect: BoardNav.Effect } => {
	let step: { state: BoardNav.BoardState; effect: BoardNav.Effect } = {
		state,
		effect: { type: "none" },
	};
	for (const name of names) step = BoardNav.reduceKey(step.state, key(name));
	return step;
};

// The loop's tab, on screen.
const onTab = (cards: ActivityCard[] = [card()]): BoardNav.BoardState =>
	press(
		BoardTabs.withActivity(BoardNav.init([], { scoped: false }), cards, []),
		"}",
	).state;

const lane = (state: BoardNav.BoardState): string | null =>
	CardTab.view(state.tabs, "loop:r1").lane;

describe("lanes", () => {
	it("open on every lane; l and h walk them in the host's order, wrapping both ways", () => {
		const s = onTab();
		expect(lane(s)).toBeNull();
		expect(lane(press(s, "l").state)).toBe("claude:JREP-2");
		expect(lane(press(s, "l", "l").state)).toBe("claude:JREP-3");
		expect(lane(press(s, "l", "l", "l").state)).toBeNull();
		expect(lane(press(s, "h").state)).toBe("claude:JREP-3");
		expect(lane(press(s, "right", "left").state)).toBeNull();
	});

	it("a card without lanes leaves h/l to nothing", () => {
		const s = onTab([card({ lanes: undefined })]);
		expect(press(s, "l").state).toBe(s);
	});

	it("keep the lane by name, so a lane the host adds does not move what is on screen", () => {
		const s = press(onTab(), "l", "l").state;
		const grown = BoardTabs.withCard(
			s,
			card({ lanes: ["claude:JREP-2", "claude:JREP-3", "codex:JREP-4"] }),
		);
		expect(lane(grown)).toBe("claude:JREP-3");
		expect(lane(press(grown, "l").state)).toBe("codex:JREP-4");
	});

	it("survive a trip to the tracker and back", () => {
		const s = press(onTab(), "l").state;
		expect(lane(press(s, "{", "}").state)).toBe("claude:JREP-2");
	});

	it("a click on a chip picks its lane; one past the chips does nothing", () => {
		const s = onTab();
		const clicked = BoardNav.reduceMouse(s, { type: "lane", index: 2 });
		expect(lane(clicked.state)).toBe("claude:JREP-3");
		const back = BoardNav.reduceMouse(clicked.state, {
			type: "lane",
			index: 0,
		});
		expect(lane(back.state)).toBeNull();
		expect(BoardNav.reduceMouse(s, { type: "lane", index: 3 }).state).toBe(s);
	});

	it("the footer offers h/l only on a card with lanes", () => {
		const facts = { linked: new Set<string>(), events: false };
		expect(BoardNav.keySituation(onTab(), facts).lanes).toBe(true);
		expect(
			BoardNav.keySituation(onTab([card({ lanes: [] })]), facts).lanes,
		).toBe(false);
	});
});

describe("the event view's refreshed card", () => {
	it("is the same state when nothing the keys read moved", () => {
		const s = onTab();
		expect(BoardTabs.withCard(s, card({ detail: ["moved"] }))).toBe(s);
	});

	it("is ignored for a card that has no tab", () => {
		const s = onTab();
		expect(BoardTabs.withCard(s, card({ id: "loop:other" }))).toBe(s);
	});
});
