// The map on a card's tab through the reducer the keyboard drives: where its cursor starts and
// follows the run, how the keys move it, fold steps and open a session's log, and how a finished
// card's left-for-you list marks its tab until it has been on screen.
import { describe, expect, it } from "bun:test";
import type { ActivityCard, ActivityStep } from "@kabane/extension";
import { CardTab } from "./card-tab";
import { BoardNav } from "./nav";
import { RunMap } from "./run-map";
import { BoardTabs } from "./tabs";

const STEPS: ActivityStep[] = [
	{
		name: "implement",
		state: "done",
		result: "1 of 1 done",
		durationMs: 122_000,
	},
	{
		name: "review",
		state: "done",
		result: "8 findings filed",
		durationMs: 429_000,
	},
	{
		name: "recheck",
		state: "running",
		result: "2 of 4 done · 2 live",
		startedAt: "2026-11-20T09:12:28.000Z",
		sessions: [
			{
				name: "functional",
				state: "done",
				lane: "functional-recheck",
				durationMs: 1000,
			},
			{
				name: "quality",
				state: "done",
				lane: "quality-recheck",
				durationMs: 1000,
			},
			{
				name: "docs",
				state: "running",
				lane: "docs-recheck",
				startedAt: "2026-11-20T09:15:39.000Z",
			},
			{
				name: "architecture",
				state: "running",
				lane: "architecture-recheck",
				startedAt: "2026-11-20T09:15:40.000Z",
			},
		],
	},
	{
		name: "land",
		state: "pending",
		result: "none: the branch stays for review",
	},
];

const card = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "loop:r1",
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "PROJ-5",
	startedAt: "2026-11-20T08:36:00.000Z",
	detail: [],
	hasEvents: true,
	tab: true,
	lanes: [
		"functional-recheck",
		"quality-recheck",
		"docs-recheck",
		"architecture-recheck",
	],
	liveLanes: ["architecture-recheck", "docs-recheck"],
	steps: STEPS,
	...over,
});

const key = (name: string): BoardNav.KeyInput => ({ name, sequence: name });

const press = (
	state: BoardNav.BoardState,
	...names: string[]
): BoardNav.BoardState => {
	let at = state;
	for (const name of names)
		at = BoardNav.sight(
			BoardNav.reduceKey(BoardNav.sight(at, 0), key(name), BoardNav.ARM_MS)
				.state,
			0,
		);
	return at;
};

const onTab = (
	cards: ActivityCard[] = [card()],
	queue: BoardTabs.Question[] = [],
): BoardNav.BoardState =>
	press(
		BoardTabs.withActivity(BoardNav.init([], { scoped: false }), cards, queue),
		"}",
	);

const cursor = (state: BoardNav.BoardState): string | undefined =>
	RunMap.cursor(
		state.tabs.cards.get("loop:r1") ?? {},
		CardTab.view(state.tabs, "loop:r1"),
		CardTab.asking(state.tabs, "loop:r1"),
	);

const keys = (state: BoardNav.BoardState): string[] =>
	RunMap.rows(
		state.tabs.cards.get("loop:r1") ?? {},
		CardTab.view(state.tabs, "loop:r1"),
	).map((row) => row.key);

describe("the run map", () => {
	it("opens the live step to its sessions and keeps the finished ones folded", () => {
		expect(keys(onTab())).toEqual([
			"step:implement",
			"step:review",
			"step:recheck",
			"step:recheck/functional-recheck",
			"step:recheck/quality-recheck",
			"step:recheck/docs-recheck",
			"step:recheck/architecture-recheck",
			"step:land",
		]);
	});

	it("starts on the live session that started last, and follows the run to a new one", () => {
		const s = onTab();
		expect(cursor(s)).toBe("step:recheck/architecture-recheck");
		const moved = BoardTabs.withCard(s, card({ liveLanes: ["docs-recheck"] }));
		expect(cursor(moved)).toBe("step:recheck/docs-recheck");
	});

	it("goes to a session that asks the human, ahead of the newest", () => {
		const asked: BoardTabs.Question = {
			id: "q1",
			cardId: "loop:r1",
			lane: "docs-recheck",
			question: "run it?",
			choices: ["yes", "no"],
			multiSelect: false,
			allowFreeform: false,
			agent: "codex",
			askedAt: "2026-11-20T09:16:40.000Z",
		};
		expect(cursor(onTab([card()], [asked]))).toBe("step:recheck/docs-recheck");
	});

	it("stays where the human moves it until f hands it back to the run", () => {
		const moved = press(onTab(), "k", "k");
		expect(cursor(moved)).toBe("step:recheck/quality-recheck");
		const later = BoardTabs.withCard(
			moved,
			card({ liveLanes: ["docs-recheck"] }),
		);
		expect(cursor(later)).toBe("step:recheck/quality-recheck");
		expect(cursor(press(later, "f"))).toBe("step:recheck/docs-recheck");
	});

	it("holds at the ends, and falls to its step when the human folds the step it was in", () => {
		expect(cursor(press(onTab(), "j", "j", "j"))).toBe("step:land");
		expect(
			cursor(press(onTab(), "up", "up", "up", "up", "up", "up", "up")),
		).toBe("step:implement");
		const folded = press(onTab(), "h");
		expect(cursor(folded)).toBe("step:recheck");
		expect(keys(folded)).toEqual([
			"step:implement",
			"step:review",
			"step:recheck",
			"step:land",
		]);
		expect(keys(press(folded, "l"))).toContain("step:recheck/docs-recheck");
	});

	it("enter opens the cursor's session log, and esc closes it before going to the tracker", () => {
		const log = press(onTab(), "enter");
		expect(CardTab.view(log.tabs, "loop:r1").lane).toBe("architecture-recheck");
		const closed = press(log, "escape");
		expect(closed.tabs.active).toBe("loop:r1");
		expect(CardTab.view(closed.tabs, "loop:r1").lane).toBeNull();
		expect(press(closed, "escape").tabs.active).toBeNull();
	});

	it("a card with no steps keeps its lanes on h/l", () => {
		const plain = onTab([card({ steps: undefined })]);
		expect(CardTab.view(press(plain, "l").tabs, "loop:r1").lane).toBe(
			"functional-recheck",
		);
	});

	it("leaves `f` to the host on a card without steps, and keeps it for following on a map", () => {
		const follow = { id: "focus", key: "f", label: "focus" };
		const plain = onTab([card({ steps: undefined, actions: [follow] })]);
		expect(
			BoardNav.reduceKey(BoardNav.sight(plain, 0), key("f"), BoardNav.ARM_MS)
				.effect,
		).toEqual({ type: "act", cardId: "loop:r1", actionId: "focus" });
		const mapped = onTab([card({ actions: [follow] })]);
		expect(
			BoardNav.reduceKey(BoardNav.sight(mapped, 0), key("f"), BoardNav.ARM_MS)
				.effect,
		).toEqual({ type: "none" });
	});
});

describe("what a finished card left", () => {
	const finished = card({
		status: "completed",
		liveLanes: undefined,
		steps: STEPS.map((step) => ({ ...step, state: "done" as const })),
		left: [
			{
				taskId: "01F1",
				taskShortId: "PROJ-22",
				how: "reopened by functional",
				reason: "a finding",
			},
			{ how: "branch proj-5", reason: "land: none" },
		],
	});

	it("keeps its tab's `?` until the tab has been on screen", () => {
		const elsewhere = BoardTabs.withActivity(
			BoardNav.init([], { scoped: false }),
			[finished],
			[],
		);
		expect(BoardTabs.unseen(elsewhere.tabs, "loop:r1")).toBe(true);
		const seen = press(elsewhere, "}");
		expect(BoardTabs.unseen(seen.tabs, "loop:r1")).toBe(false);
		expect(BoardTabs.unseen(press(seen, "{").tabs, "loop:r1")).toBe(false);
	});

	it("a branch alone is not something to come back for", () => {
		const branchOnly = card({
			status: "completed",
			left: [{ how: "branch proj-5", reason: "land: none" }],
		});
		const s = BoardTabs.withActivity(
			BoardNav.init([], { scoped: false }),
			[branchOnly],
			[],
		);
		expect(BoardTabs.unseen(s.tabs, "loop:r1")).toBe(false);
	});

	it("enter on an issue it left opens it on the tracker", () => {
		const s = onTab([finished]);
		const last = RunMap.rows(s.tabs.cards.get("loop:r1") ?? {}, {}).findLast(
			(row) => row.type === "left" && row.item.taskId,
		);
		const view = CardTab.view(s.tabs, "loop:r1");
		const on = {
			...s,
			tabs: {
				...s.tabs,
				views: new Map(s.tabs.views).set("loop:r1", {
					...view,
					cursor: last?.key,
					follow: false,
				}),
			},
		};
		const opened = press(on, "enter");
		expect(opened.tabs.active).toBeNull();
		expect(opened.view).toEqual({ type: "detail", taskId: "01F1" });
	});
});
