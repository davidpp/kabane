// The tab bar and the attention queue through the same reducer the keyboard and the mouse drive:
// which tab is on screen, where `!` lands, what a banner's digits answer and when it clears.
import { describe, expect, it } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardNav } from "./nav";
import type { ActivityCard } from "./ports";
import { BoardTabs } from "./tabs";

const task = (id: string, shortId: string): Task => ({
	id,
	shortId,
	title: `Task ${shortId}`,
	kind: "issue",
	state: "in_progress",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-10-10T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-10-10T00:00:00.000Z",
	updatedAt: "2026-10-10T00:00:00.000Z",
});

// JREP-1 is the loop's parent; JREP-3 a subtask its session asks about; JREP-9 has nothing to do
// with the loop and its own agent asks about it.
const base = (): BoardNav.BoardState =>
	BoardNav.init(
		[
			{
				state: "in_progress",
				label: TASK_STATE_DISPLAY.in_progress.label,
				rows: [
					{ task: task("p1", "JREP-1"), children: [task("t3", "JREP-3")] },
					{ task: task("t9", "JREP-9"), children: [] },
				],
			},
		],
		{ scoped: false },
	);

const card = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "loop:r1",
	kind: "loops",
	label: "loop",
	status: "running",
	taskId: "p1",
	taskShortId: "JREP-1",
	startedAt: "2026-10-10T00:00:00.000Z",
	detail: [],
	hasEvents: true,
	tab: true,
	sessionIds: ["s-loop"],
	...over,
});

const question = (
	over: Partial<BoardTabs.Question> = {},
): BoardTabs.Question => ({
	taskId: "t3",
	taskShortId: "JREP-3",
	sessionId: "s-loop",
	questionActivityId: "q-loop",
	question: "Evict by LRU or by TTL?",
	choices: ["LRU", "TTL"],
	agent: "claude",
	askedAt: "2026-10-10T00:01:00.000Z",
	...over,
});

// The loop's question was asked second; the stand-alone agent's first, so it is the oldest.
const LOOP_Q = question();
const SOLO_Q = question({
	taskId: "t9",
	taskShortId: "JREP-9",
	sessionId: "s-solo",
	questionActivityId: "q-solo",
	question: "Pin 0.5.10 or take the minor?",
	choices: ["Pin", "Take"],
	agent: "hermes",
	askedAt: "2026-10-10T00:00:30.000Z",
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

const withLoop = (
	cards: ActivityCard[] = [card()],
	queue: BoardTabs.Question[] = [SOLO_Q, LOOP_Q],
): BoardNav.BoardState => BoardTabs.withActivity(base(), cards, queue);

describe("the tab bar follows the cards that ask for a tab", () => {
	it("opens a tab per tabbed card in the order they appear, and none for the rest", () => {
		const s = withLoop([
			card({ id: "loop:r2" }),
			card({ id: "runs:x", tab: undefined }),
			card(),
		]);
		expect(s.tabs.open).toEqual(["loop:r2", "loop:r1"]);
		expect(s.tabs.active).toBeNull();
		expect(s.view).toEqual({ type: "board" });
	});

	it("is the same state when a poll brings nothing new", () => {
		const s = withLoop();
		expect(BoardTabs.withActivity(s, [card()], [SOLO_Q, LOOP_Q])).toBe(s);
	});

	it("a card the host stops listing loses its tab, and the tracker comes back if it was on screen", () => {
		const onTab = press(withLoop(), "}").state;
		expect(onTab.tabs.active).toBe("loop:r1");
		const gone = BoardTabs.withActivity(onTab, [], []);
		expect(gone.tabs.open).toEqual([]);
		expect(gone.tabs.active).toBeNull();
		expect(gone.view).toEqual({ type: "board" });
	});

	it("counts every question on the tracker and its own sessions' on a card", () => {
		const s = withLoop();
		expect(BoardTabs.waitingOn(s.tabs, null)).toBe(2);
		expect(BoardTabs.waitingOn(s.tabs, "loop:r1")).toBe(1);
	});
});

describe("{ and } walk the tabs", () => {
	it("wraps through the tracker and back, keeping the tracker's view for its return", () => {
		const detail = {
			...withLoop(),
			view: { type: "detail" as const, taskId: "t9" },
		};
		const onCard = press(detail, "}");
		expect(onCard.state.tabs.active).toBe("loop:r1");
		expect(onCard.state.view).toEqual({
			type: "events",
			cardId: "loop:r1",
			fromView: "board",
		});
		const back = press(onCard.state, "}");
		expect(back.state.tabs.active).toBeNull();
		expect(back.state.view).toEqual({ type: "detail", taskId: "t9" });
		expect(press(detail, "{").state.tabs.active).toBe("loop:r1");
	});

	it("says so when there is no other tab", () => {
		const s = base();
		const { state, effect } = press(s, "}");
		expect(state).toBe(s);
		expect(effect).toEqual({
			type: "notice",
			notice: { text: "no other tabs", tone: "success" },
		});
	});

	it("are query characters while a search is typed", () => {
		const typing = {
			...withLoop(),
			search: { mode: "typing" as const, query: "" },
		};
		const { state } = press(typing, "}");
		expect(state.tabs.active).toBeNull();
		expect(state.search).toEqual({ mode: "typing", query: "}" });
	});
});

describe("! walks every unanswered question, oldest first", () => {
	it("says so when nothing waits", () => {
		const { effect } = press(withLoop([card()], []), "!");
		expect(effect).toEqual({
			type: "notice",
			notice: { text: "nothing is waiting on you", tone: "success" },
		});
	});

	it("lands a stand-alone session's question on its task, pinned, then a card's on the card's tab, then wraps", () => {
		const first = press(withLoop(), "!").state;
		expect(first.tabs.active).toBeNull();
		expect(first.view).toEqual({
			type: "detail",
			taskId: "t9",
			banner: { question: SOLO_Q },
		});
		const second = press(first, "!").state;
		expect(second.tabs.active).toBe("loop:r1");
		expect(second.view.type).toBe("events");
		expect(BoardTabs.cardQuestion(second.tabs)).toEqual(LOOP_Q);
		const third = press(second, "!").state;
		expect(third.tabs.active).toBeNull();
		expect(third.view).toMatchObject({ taskId: "t9" });
	});

	it("a question whose card's tab was closed lands on its task instead", () => {
		const done = withLoop([card({ status: "completed" })], [LOOP_Q]);
		const closed = press(done, "}", "w").state;
		expect(closed.tabs.open).toEqual([]);
		const landed = press(closed, "!").state;
		expect(landed.view).toEqual({
			type: "detail",
			taskId: "t3",
			banner: { question: LOOP_Q },
		});
	});
});

describe("a card's tab", () => {
	const onTab = (s: BoardNav.BoardState = withLoop()) => press(s, "}").state;

	it("o pins its question over the question's task, and b goes back to the tab", () => {
		const opened = press(onTab(), "o").state;
		expect(opened.tabs.active).toBeNull();
		expect(opened.view).toEqual({
			type: "detail",
			taskId: "t3",
			banner: { question: LOOP_Q, cardId: "loop:r1" },
		});
		const back = press(opened, "b").state;
		expect(back.tabs.active).toBe("loop:r1");
		expect(back.view.type).toBe("events");
	});

	it("o with nothing asked opens the card's own task", () => {
		const opened = press(onTab(withLoop([card()], [])), "o").state;
		expect(opened.view).toEqual({ type: "detail", taskId: "p1" });
	});

	it("o resolves a card that only knows its task's short id", () => {
		const shortOnly = withLoop([card({ taskId: undefined })], []);
		expect(press(onTab(shortOnly), "o").state.view).toEqual({
			type: "detail",
			taskId: "p1",
		});
	});

	it("esc and q go to the tracker rather than down a stack", () => {
		for (const name of ["escape", "q"]) {
			const { state, effect } = press(onTab(), name);
			expect(state.tabs.active).toBeNull();
			expect(state.view).toEqual({ type: "board" });
			expect(effect.type).toBe("none");
		}
	});

	it("w closes a finished card's tab for good, and refuses a running one", () => {
		const running = press(onTab(), "w");
		expect(running.state.tabs.open).toEqual(["loop:r1"]);
		expect(running.effect).toEqual({
			type: "notice",
			notice: {
				text: "still running · w closes it once it ends",
				tone: "success",
			},
		});
		const finished = onTab(withLoop([card({ status: "failed" })]));
		const { state: closed, effect } = press(finished, "w");
		// The host is told, so it stops listing the card across a relaunch too.
		expect(effect).toEqual({ type: "dismiss", cardId: "loop:r1" });
		expect(closed.tabs.open).toEqual([]);
		expect(closed.tabs.active).toBeNull();
		// The next poll still lists it; it stays closed.
		const polled = BoardTabs.withActivity(
			closed,
			[card({ status: "failed" })],
			[],
		);
		expect(polled.tabs.open).toEqual([]);
	});

	it("j/k still scroll the events under it", () => {
		expect(press(onTab(), "j").effect).toEqual({ type: "scroll", delta: 2 });
	});
});

describe("the pinned banner", () => {
	const pinned = (): BoardNav.BoardState => press(withLoop(), "!").state;

	it("a digit answers with the answer it numbers; one past the answers does nothing at all", () => {
		expect(press(pinned(), "2").effect).toEqual({
			type: "answerQuestion",
			questionId: "q-solo",
			answer: "Take",
		});
		const s = pinned();
		const past = press(s, "3");
		expect(past.effect.type).toBe("none");
		expect(past.state).toBe(s);
		// h/l still walk the sections under the banner.
		expect(press(s, "l").state.view).toMatchObject({ type: "detail" });
		expect(press(s, "l").state).not.toBe(s);
	});

	it("b does nothing without a card to go back to", () => {
		const s = pinned();
		expect(press(s, "b").state).toBe(s);
	});

	it("once answered it says so, takes no more digits, and clears when the human leaves", () => {
		const answered = BoardTabs.withAnswered(pinned(), "q-solo", "Pin");
		const view = answered.view;
		expect(view.type === "detail" && view.banner?.answer).toBe("Pin");
		expect(press(answered, "1").effect.type).toBe("none");
		expect(press(answered, "2").state).toBe(answered);
		// The poll takes it out of the queue; the banner stays up until the human leaves.
		const polled = BoardTabs.withActivity(answered, [card()], [LOOP_Q]);
		expect(polled.view).toMatchObject({ banner: { answer: "Pin" } });
		const away = press(polled, "}").state;
		const back = press(away, "{").state;
		expect(back.view).toEqual({ type: "detail", taskId: "t9" });
	});

	it("an unanswered one is still pinned when the human comes back to the tracker", () => {
		const back = press(pinned(), "}", "{").state;
		expect(back.view).toEqual({
			type: "detail",
			taskId: "t9",
			banner: { question: SOLO_Q },
		});
	});

	it("a question answered somewhere else reads as settled", () => {
		const s = pinned();
		const view = s.view;
		if (view.type !== "detail" || !view.banner) throw new Error("no banner");
		expect(BoardTabs.isAnswered(s.tabs, view.banner)).toBe(false);
		const polled = BoardTabs.withActivity(s, [card()], [LOOP_Q]);
		expect(BoardTabs.isAnswered(polled.tabs, view.banner)).toBe(true);
		expect(press(polled, "1").effect.type).toBe("none");
	});
});

describe("the mouse", () => {
	it("a click on a tab shows it; on the tab already shown, or one that is not open, nothing", () => {
		const s = withLoop();
		const clicked = BoardNav.reduceMouse(s, { type: "tab", id: "loop:r1" });
		expect(clicked.state.tabs.active).toBe("loop:r1");
		expect(BoardNav.reduceMouse(s, { type: "tab", id: null }).state).toBe(s);
		expect(
			BoardNav.reduceMouse(s, { type: "tab", id: "loop:nope" }).state,
		).toBe(s);
		const home = BoardNav.reduceMouse(clicked.state, { type: "tab", id: null });
		expect(home.state.tabs.active).toBeNull();
	});

	it("a click on an answer is its digit", () => {
		const pinned = press(withLoop(), "!").state;
		expect(
			BoardNav.reduceMouse(pinned, { type: "answer", index: 0 }).effect,
		).toEqual({ type: "answerQuestion", questionId: "q-solo", answer: "Pin" });
		expect(
			BoardNav.reduceMouse(withLoop(), { type: "answer", index: 0 }).effect
				.type,
		).toBe("none");
	});
});

describe("what the footer offers", () => {
	const facts = { linked: new Set<string>(), events: false };

	it("! while anything waits, w only on a finished card's tab, b only with a card to go back to", () => {
		expect(BoardNav.keySituation(base(), facts)).toMatchObject({
			waiting: false,
			tabs: false,
		});
		const loop = withLoop();
		expect(BoardNav.keySituation(loop, facts)).toMatchObject({
			waiting: true,
			tabs: true,
			closable: false,
		});
		const finished = press(
			withLoop([card({ status: "completed" })]),
			"}",
		).state;
		expect(BoardNav.keySituation(finished, facts).closable).toBe(true);
		expect(BoardNav.keyContext(finished)).toBe("cardTab");
		const opened = press(press(loop, "}").state, "o").state;
		expect(BoardNav.keySituation(opened, facts)).toMatchObject({
			back: true,
			unanswered: true,
		});
		const solo = press(loop, "!").state;
		expect(BoardNav.keySituation(solo, facts)).toMatchObject({
			back: false,
			unanswered: true,
		});
	});
});
