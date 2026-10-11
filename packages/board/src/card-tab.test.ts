// A card's own tab through the same reducer the keyboard and the mouse drive: its lanes, its
// actions and the prompt they open, and a question it shows that takes a typed answer.
import { describe, expect, it } from "bun:test";
import { CardTab } from "./card-tab";
import { BoardNav } from "./nav";
import type { ActivityCard, CardAction } from "./ports";
import { BoardPrompt } from "./prompt";
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

describe("the header", () => {
	it("e expands and folds it, per card, across a trip to the tracker", () => {
		const s = onTab();
		const expanded = (state: BoardNav.BoardState): boolean =>
			CardTab.view(state.tabs, "loop:r1").expanded;
		expect(expanded(s)).toBe(false);
		expect(expanded(press(s, "e").state)).toBe(true);
		expect(expanded(press(s, "e", "{", "}").state)).toBe(true);
		expect(expanded(press(s, "e", "e").state)).toBe(false);
	});

	it("the footer offers e only when the host has a header for the card", () => {
		const facts = { linked: new Set<string>(), events: false };
		expect(BoardNav.keySituation(onTab(), facts).header).toBe(false);
		expect(
			BoardNav.keySituation(onTab(), { ...facts, header: true }).header,
		).toBe(true);
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

const STOP: CardAction = { id: "stop", key: "x", label: "stop" };
const INJECT: CardAction = {
	id: "inject",
	key: "i",
	label: "inject",
	input: "a prompt for this session",
	lane: true,
};
const acting = (over: Partial<ActivityCard> = {}): BoardNav.BoardState =>
	onTab([card({ actions: [STOP, INJECT], ...over })]);

describe("actions", () => {
	it("x runs the card's stop, with the lane on screen, and nothing on a card that offers none", () => {
		expect(press(acting(), "x").effect).toEqual({
			type: "act",
			cardId: "loop:r1",
			actionId: "stop",
		});
		expect(press(acting(), "l", "x").effect).toEqual({
			type: "act",
			cardId: "loop:r1",
			actionId: "stop",
			lane: "claude:JREP-2",
		});
		const none = onTab();
		expect(press(none, "x")).toEqual({ state: none, effect: { type: "none" } });
	});

	it("x is reserved: no other action takes it, and a finished card is not stopped", () => {
		const s = onTab([
			card({ actions: [{ id: "explode", key: "x", label: "explode" }] }),
		]);
		expect(press(s, "x").effect.type).toBe("none");
		expect(press(acting({ status: "completed" }), "x").effect.type).toBe(
			"none",
		);
	});

	it("an action aimed at a lane, on a card with none yet, says so and is left out of the footer", () => {
		const s = acting({ lanes: [] });
		expect(press(s, "i").effect).toEqual({
			type: "notice",
			notice: { text: "no agents to inject yet", tone: "success" },
		});
		expect(CardTab.hints(s)).toEqual([]);
	});

	it("an action aimed at a lane asks for one first", () => {
		const { state, effect } = press(acting(), "i");
		expect(state.prompt.open).toBeNull();
		expect(effect).toEqual({
			type: "notice",
			notice: {
				text: "inject goes to one of the agents · h/l picks it",
				tone: "success",
			},
		});
	});

	it("an action with input opens the prompt aimed at the lane on screen, and enter sends it", () => {
		const opened = press(acting(), "l", "i").state;
		expect(opened.prompt.open).toEqual({
			target: {
				type: "act",
				cardId: "loop:r1",
				actionId: "inject",
				lane: "claude:JREP-2",
			},
			title: "inject",
			aim: "claude:JREP-2",
			placeholder: "a prompt for this session",
		});
		expect(BoardNav.keyContext(opened)).toBe("prompt");
		// Every key but the prompt's own is the textarea's: `x` is a character here, not stop.
		expect(press(opened, "x")).toEqual({
			state: opened,
			effect: { type: "none" },
		});
		const sent = BoardPrompt.submit(opened, "use the LRU\nand say why");
		expect(sent.effect).toEqual({
			type: "act",
			cardId: "loop:r1",
			actionId: "inject",
			text: "use the LRU\nand say why",
			lane: "claude:JREP-2",
		});
		expect(sent.state.prompt.open).toBeNull();
		expect(sent.state.prompt.history).toEqual(["use the LRU\nand say why"]);
	});

	it("esc drops the prompt and an empty one sends nothing", () => {
		const opened = press(acting(), "l", "i").state;
		expect(BoardPrompt.submit(opened, "  ").effect.type).toBe("none");
		expect(press(opened, "escape").state.prompt.open).toBeNull();
	});

	it("up on an empty prompt recalls what was sent before", () => {
		const once = BoardPrompt.submit(
			press(acting(), "l", "i").state,
			"first",
		).state;
		const again = press(once, "i").state;
		expect(BoardPrompt.consumes(again, key("up"))).toBe(true);
		expect(press(again, "up").effect).toEqual({
			type: "promptSetText",
			text: "first",
		});
	});

	it("a click elsewhere closes the prompt", () => {
		const opened = press(acting(), "l", "i").state;
		const clicked = BoardNav.reduceMouse(opened, { type: "lane", index: 0 });
		expect(clicked.state.prompt.open).toBeNull();
	});

	it("the footer names the card's own keys, never one the board keeps", () => {
		const s = onTab([
			card({
				actions: [
					STOP,
					INJECT,
					{ id: "jump", key: "j", label: "jump" },
					{ id: "pause", key: "p", label: "pause" },
				],
			}),
		]);
		expect(CardTab.hints(s)).toEqual([
			{ key: "i", label: "inject" },
			{ key: "p", label: "pause" },
		]);
		const facts = { linked: new Set<string>(), events: false };
		expect(BoardNav.keySituation(s, facts).stoppable).toBe(true);
		expect(
			BoardNav.keySituation(acting({ status: "stopped" }), facts).stoppable,
		).toBe(false);
	});
});

describe("a question that offers no answers", () => {
	const asked: BoardTabs.Question = {
		taskId: "t3",
		taskShortId: "JREP-3",
		sessionId: "s-loop",
		questionActivityId: "q-free",
		question: "What should the cache key be?",
		choices: [],
		agent: "claude",
		askedAt: "2026-10-10T00:01:00.000Z",
	};
	const waiting = (): BoardNav.BoardState =>
		press(
			BoardTabs.withActivity(
				BoardNav.init([], { scoped: false }),
				[card({ sessionIds: ["s-loop"] })],
				[asked],
			),
			"}",
		).state;

	it("enter on the card's tab types the answer, and the prompt sends it to answerQuestion", () => {
		const opened = press(waiting(), "return").state;
		expect(opened.prompt.open?.target).toEqual({
			type: "answer",
			questionId: "q-free",
		});
		expect(BoardPrompt.submit(opened, "the parsed path").effect).toEqual({
			type: "answerQuestion",
			questionId: "q-free",
			answer: "the parsed path",
		});
	});

	it("enter on its banner over the task does the same, and the digits do nothing", () => {
		const pinned = press(waiting(), "o").state;
		expect(pinned.view).toMatchObject({ type: "detail", banner: {} });
		expect(press(pinned, "1").state).toBe(pinned);
		const opened = press(pinned, "return").state;
		expect(opened.prompt.open?.aim).toBe("JREP-3");
		const facts = { linked: new Set<string>(), events: false };
		expect(BoardNav.keySituation(pinned, facts).freeform).toBe(true);
	});

	it("enter means nothing on a question with answers to pick", () => {
		const s = press(
			BoardTabs.withActivity(
				BoardNav.init([], { scoped: false }),
				[card({ sessionIds: ["s-loop"] })],
				[{ ...asked, choices: ["path", "hash"] }],
			),
			"}",
		).state;
		expect(press(s, "return").state.prompt.open).toBeNull();
	});
});
