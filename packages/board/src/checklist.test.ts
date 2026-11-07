// An issue's checklist on the board's state: the cursor `J/K` move, `space` toggling the item under
// it through the one key router, a press shown until the records agree, and the cards' `3/5`.
import { describe, expect, it } from "bun:test";
import type { ChecklistItemView } from "@cabane/checklist";
import { BoardChecklist } from "./checklist";
import { BoardDecisions } from "./decisions";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { Fixtures } from "./stories/fixtures";

const { task, section, item } = Fixtures;

const ISSUE = task({ id: "w", shortId: "JREP-7" });
const OTHER = task({ id: "o", shortId: "JREP-3" });

const READ = item(ISSUE, 1, "Read the store", true);
const WRITE = item(ISSUE, 2, "Write the store");
const DROP = item(ISSUE, 3, "Drop the old one");

const board = (): BoardNav.BoardState =>
	BoardNav.init(
		[
			section("next", [
				{ task: ISSUE, children: [] },
				{ task: OTHER, children: [] },
			]),
		],
		{ scoped: true },
	);

// ISSUE's detail with `items` its checklist, as its records bring them.
const detail = (
	items: readonly ChecklistItemView[] = [READ, WRITE, DROP],
): BoardNav.BoardState =>
	BoardChecklist.withOpen(
		{ ...board(), view: { type: "detail", taskId: "w" } },
		"w",
		items,
	);

type Reduced = { state: BoardNav.BoardState; effect: BoardNav.Effect };

const press = (s: BoardNav.BoardState, name: string): Reduced =>
	BoardNav.reduceKey(
		BoardNav.sight(s, 0),
		name.length === 1 ? { name, sequence: name } : { name },
		BoardNav.ARM_MS,
	);

const keys = (s: BoardNav.BoardState, ...names: string[]): Reduced =>
	names.reduce<Reduced>((r, name) => press(r.state, name), {
		state: s,
		effect: { type: "none" },
	});

const cursorOf = (s: BoardNav.BoardState): string | undefined => {
	const shown = BoardChecklist.shown(s);
	return shown?.lines.find((line) => line.id === shown.cursor)?.text;
};

const doneOf = (s: BoardNav.BoardState): boolean[] =>
	BoardChecklist.shown(s)?.lines.map((line) => line.done) ?? [];

describe("the checklist on an issue's detail", () => {
	it("opens its cursor on the first open item, where a loop resumes", () => {
		expect(cursorOf(detail())).toBe("Write the store");
		expect(cursorOf(detail([READ, { ...WRITE, done: true }]))).toBe(
			"Read the store",
		);
	});

	it("moves the cursor with J and K, stopping at either end, and reveals its row", () => {
		const down = press(detail(), "J");
		expect(cursorOf(down.state)).toBe("Drop the old one");
		expect(down.effect).toEqual({
			type: "reveal",
			id: BoardChecklist.rowId(DROP.id),
		});
		expect(press(down.state, "J").effect).toEqual({ type: "none" });
		expect(cursorOf(keys(detail(), "K", "K").state)).toBe("Read the store");
	});

	it("takes a shifted j as J, whatever name the terminal gives it", () => {
		const shifted = BoardNav.reduceKey(
			BoardNav.sight(detail(), 0),
			{ name: "j", sequence: "J", shift: true },
			BoardNav.ARM_MS,
		);
		expect(cursorOf(shifted.state)).toBe("Drop the old one");
		// A plain j still scrolls the view.
		expect(press(detail(), "j").effect).toEqual({ type: "scroll", delta: 2 });
	});

	it("toggles the item under the cursor with space, showing the press at once", () => {
		const ticked = press(detail(), "space");
		expect(ticked.effect).toEqual({
			type: "tickItem",
			itemId: WRITE.id,
			handle: "JREP-7.2",
			done: true,
		});
		expect(doneOf(ticked.state)).toEqual([true, true, false]);
		expect(BoardChecklist.shown(ticked.state)?.progress).toEqual({
			done: 2,
			total: 3,
		});
		// The cursor stays on the item just ticked, so a second press takes it back.
		const back = press(ticked.state, "space");
		expect(back.effect).toMatchObject({ itemId: WRITE.id, done: false });
		expect(doneOf(back.state)).toEqual([true, false, false]);
	});

	it("unticks a done item", () => {
		expect(keys(detail(), "K", "space").effect).toMatchObject({
			itemId: READ.id,
			done: false,
		});
	});

	it("keeps a press until the records agree, and drops it once they do", () => {
		const ticked = press(detail(), "space").state;
		// The poll lands before the write: the records still say open, the press still shows.
		const before = BoardChecklist.withOpen(ticked, "w", [READ, WRITE, DROP]);
		expect(doneOf(before)).toEqual([true, true, false]);
		const after = BoardChecklist.withOpen(ticked, "w", [
			READ,
			{ ...WRITE, done: true },
			DROP,
		]);
		expect(after.checklist.flipped.size).toBe(0);
		expect(doneOf(after)).toEqual([true, true, false]);
	});

	it("takes a press back when its write fails", () => {
		const ticked = press(detail(), "space").state;
		expect(doneOf(BoardChecklist.withFailed(ticked, WRITE.id))).toEqual([
			true,
			false,
			false,
		]);
	});

	it("shows a tick made elsewhere when the records bring it, a cursor left alone following the first open item", () => {
		const fresh = BoardChecklist.withOpen(detail(), "w", [
			READ,
			{ ...WRITE, done: true },
			DROP,
		]);
		expect(doneOf(fresh)).toEqual([true, true, false]);
		expect(cursorOf(fresh)).toBe("Drop the old one");
		// One the human moved stays where they put it, on a done item too.
		const moved = press(detail(), "K").state;
		expect(
			cursorOf(
				BoardChecklist.withOpen(moved, "w", [
					READ,
					{ ...WRITE, done: true },
					DROP,
				]),
			),
		).toBe("Read the store");
	});

	it("keeps the cursor across reloads of the same issue, and starts it over on another", () => {
		const moved = press(detail(), "J").state;
		expect(
			cursorOf(BoardChecklist.withOpen(moved, "w", [READ, WRITE, DROP])),
		).toBe("Drop the old one");
		// The item under the cursor went away: back on the first open one.
		expect(cursorOf(BoardChecklist.withOpen(moved, "w", [READ, WRITE]))).toBe(
			"Write the store",
		);
		const elsewhere = BoardChecklist.withOpen(
			{ ...moved, view: { type: "detail", taskId: "o" } },
			"o",
			[item(OTHER, 1, "Only step")],
		);
		expect(elsewhere.checklist.cursor).toBeNull();
	});

	it("acts only on the description tab, with the board holding the keys", () => {
		const s = detail();
		const comments: BoardNav.BoardState = {
			...s,
			view: { type: "detail", taskId: "w", tab: "comments" },
		};
		expect(press(comments, "space").effect).toEqual({ type: "none" });
		expect(BoardChecklist.listed(comments)).toBe(false);
		expect(
			BoardChecklist.reduceKey({ ...s, focus: "copilot" }, { name: "space" }),
		).toBeNull();
		expect(BoardChecklist.listed(s)).toBe(true);
		// An issue without items leaves space and J/K to nobody.
		expect(BoardChecklist.listed(detail([]))).toBe(false);
		expect(press(detail([]), "space").effect).toEqual({ type: "none" });
	});

	it("leaves space to a multi-select decision on screen", () => {
		const decided = BoardDecisions.withOpen(detail(), "w", [
			Fixtures.decision(ISSUE, 1, "Which checks?", {
				choices: ["Lint", "Tests"],
				multiSelect: true,
				allowFreeform: false,
			}),
		]);
		const toggled = press(decided, "space");
		expect(toggled.effect).toEqual({ type: "none" });
		expect(toggled.state.decisions.draft?.draft.picked).toEqual([0]);
		expect(doneOf(toggled.state)).toEqual([true, false, false]);
		// The footer does not offer space while the decision has it.
		const live = BoardNav.keySituation(toggled.state, {
			linked: new Set(),
			events: false,
		});
		expect(Keymap.footer("detail", live).map((h) => h.key)).not.toContain(
			"space",
		);
	});

	it("toggles an item a click lands on, moving the cursor there", () => {
		const clicked = BoardNav.reduceMouse(detail(), {
			type: "checklistItem",
			id: DROP.id,
		});
		expect(clicked.effect).toMatchObject({ itemId: DROP.id, done: true });
		expect(cursorOf(clicked.state)).toBe("Drop the old one");
	});

	it("offers space in the footer while an item is under the cursor", () => {
		const live = BoardNav.keySituation(detail(), {
			linked: new Set(),
			events: false,
		});
		expect(Keymap.footer("detail", live)[0]).toEqual({
			key: "space",
			label: "toggle item",
		});
	});
});

describe("the cards' progress", () => {
	it("reads n/m for a task with items, and nothing for one without", () => {
		expect(BoardChecklist.badge({ done: 2, total: 5 })).toBe(" · 2/5");
		expect(BoardChecklist.badge(undefined)).toBe("");
		expect(BoardChecklist.badge({ done: 0, total: 0 })).toBe("");
	});

	it("takes the poll's progress, and keeps the last when a read failed", () => {
		const s = BoardChecklist.withProgress(
			board(),
			new Map([["w", { done: 1, total: 3 }]]),
		);
		expect(s.checklist.progress.get("w")).toEqual({ done: 1, total: 3 });
		expect(BoardChecklist.withProgress(s, undefined)).toBe(s);
	});
});
