// A card without a tab, acted on from its task's detail through the reducer the keyboard drives:
// `X` stops it while `x` still cancels the task, and its other actions answer only where the
// detail has no key of its own.
import { describe, expect, it } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import type { ActivityCard } from "@cabane/extension";
import { DetailCard } from "./detail-card";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { BoardTabs } from "./tabs";

const TASK: Task = {
	id: "01H000000000000000000000AA",
	shortId: "MILL-1",
	title: "A task",
	kind: "issue",
	state: "in_progress",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-10-10T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-10-10T00:00:00.000Z",
	updatedAt: "2026-10-10T00:00:00.000Z",
};

const STOP = { id: "stop", key: "x", label: "stop" };

// A recipe run on MILL-1: no tab, still going, offering stop.
const run = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "recipes:run-1",
	kind: "runs",
	label: "review",
	status: "running",
	taskShortId: "MILL-1",
	startedAt: "2026-10-10T00:00:00.000Z",
	detail: [],
	actions: [STOP],
	...over,
});

// MILL-1's detail, with `cards` as the last poll listed them.
const onDetail = (cards: ActivityCard[] = [run()]): BoardNav.BoardState => {
	const board = BoardNav.init(
		[
			{
				state: "in_progress",
				label: TASK_STATE_DISPLAY.in_progress.label,
				rows: [{ task: TASK, children: [] }],
			},
		],
		{ scoped: false },
	);
	return BoardTabs.withActivity(
		{ ...board, view: { type: "detail", taskId: TASK.id } },
		cards,
		[],
	);
};

const press = (
	state: BoardNav.BoardState,
	key: BoardNav.KeyInput,
): { state: BoardNav.BoardState; effect: BoardNav.Effect } =>
	BoardNav.reduceKey(BoardNav.sight(state, 0), key, BoardNav.ARM_MS);

const typed = (name: string): BoardNav.KeyInput => ({ name, sequence: name });
// How OpenTUI parses a shifted letter: its base name with shift, the letter itself as the sequence.
const SHIFT_X: BoardNav.KeyInput = { name: "x", shift: true, sequence: "X" };

describe("X on an issue's detail", () => {
	it("stops the task's card that has no tab, as OpenTUI and a bare sequence both send it", () => {
		const act: BoardNav.Effect = {
			type: "act",
			cardId: "recipes:run-1",
			actionId: "stop",
		};
		expect(press(onDetail(), SHIFT_X).effect).toEqual(act);
		expect(press(onDetail(), typed("X")).effect).toEqual(act);
	});

	it("stops an idle run, which reports completed yet still offers stop", () => {
		const idle = onDetail([run({ status: "completed" })]);
		expect(press(idle, SHIFT_X).effect).toEqual({
			type: "act",
			cardId: "recipes:run-1",
			actionId: "stop",
		});
		expect(DetailCard.stoppable(idle)).toBe("review");
	});

	it("stops the newest card that offers stop, past a newer one that offers none", () => {
		const state = onDetail([
			run({
				id: "recipes:run-2",
				status: "stopped",
				actions: [{ id: "open", key: "p", label: "open" }],
			}),
			run(),
		]);
		expect(press(state, SHIFT_X).effect).toEqual({
			type: "act",
			cardId: "recipes:run-1",
			actionId: "stop",
		});
	});

	it("does nothing without a card to stop, and never cancels the task in its place", () => {
		for (const cards of [
			[],
			[run({ status: "stopped", actions: [] })],
			[run({ actions: [{ id: "open", key: "p", label: "open" }] })],
			[run({ taskShortId: "MILL-9" })],
			[run({ tab: true })],
		]) {
			const state = onDetail(cards);
			const step = press(state, SHIFT_X);
			expect(step.effect).toEqual({ type: "none" });
			expect(step.state.view).toEqual(state.view);
			expect(step.state.undo).toEqual(state.undo);
		}
	});

	it("leaves x to cancel the task", () => {
		const step = press(onDetail(), typed("x"));
		expect(step.effect.type).not.toBe("act");
		expect(step.state.undo.length).toBe(1);
	});
});

describe("the card's other actions on the detail", () => {
	const actions = [
		STOP,
		{ id: "open", key: "p", label: "open in hc" },
		{ id: "note", key: "c", label: "note", input: "what to add" },
		{ id: "redo", key: "v", label: "redo" },
		{ id: "nudge", key: "u", label: "nudge" },
		{ id: "tell", key: "z", label: "tell", lane: true },
	];

	it("run under a key the detail leaves free, through the prompt when they take text", () => {
		const state = onDetail([run({ actions })]);
		expect(press(state, typed("p")).effect).toEqual({
			type: "act",
			cardId: "recipes:run-1",
			actionId: "open",
		});
		const prompted = press(state, typed("c")).state;
		expect(prompted.prompt.open).toMatchObject({
			target: { type: "act", cardId: "recipes:run-1", actionId: "note" },
			placeholder: "what to add",
		});
	});

	it("are not offered under the detail's own keys, nor when aimed at a lane", () => {
		const state = onDetail([run({ actions })]);
		expect(DetailCard.hints(state)).toEqual([
			{ key: "p", label: "open in hc" },
			{ key: "c", label: "note" },
		]);
		expect(press(state, typed("v")).effect.type).not.toBe("act");
		expect(press(state, typed("z")).effect).toEqual({ type: "none" });
	});
});

describe("the detail's footer", () => {
	const footer = (state: BoardNav.BoardState): string =>
		Keymap.hintLine(
			Keymap.footer(
				BoardNav.keyContext(state),
				BoardNav.keySituation(state, { linked: new Set(), events: false }),
				DetailCard.hints(state),
			),
		);

	it("names the card X stops while it offers stop, and drops it once the host stops offering it", () => {
		expect(footer(onDetail())).toContain("X stop review");
		expect(
			footer(onDetail([run({ status: "stopped", actions: [] })])),
		).not.toContain("X stop");
	});
});
