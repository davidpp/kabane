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

	it("names the cursor's row while `now` draws it, the same through a scroll, so the screen reveals it once per opening", () => {
		const opened = BoardChecklist.onScreen(detail());
		expect(opened).toEqual({
			taskId: "w",
			rowId: BoardChecklist.rowId(WRITE.id),
		});
		// A page down moves the view, not the cursor: the same task, nothing to reveal again.
		const paged = press(detail(), "G");
		expect(paged.effect).toEqual({ type: "scroll", to: "end" });
		expect(BoardChecklist.onScreen(paged.state)?.taskId).toBe("w");
		expect(cursorOf(paged.state)).toBe("Write the store");
		// Another tab draws no checklist; coming back to `now` is a new opening.
		const away = press(detail(), "2").state;
		expect(BoardChecklist.onScreen(away)).toBeNull();
		expect(BoardChecklist.onScreen(press(away, "1").state)?.taskId).toBe("w");
	});

	it("brings the cursor's row back into view on space, whatever scrolled it off", () => {
		const scrolled = keys(detail(), "G", "space");
		expect(scrolled.state.checklist.pressed).toEqual({ itemId: WRITE.id });
		expect(doneOf(scrolled.state)).toEqual([true, true, false]);
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
		// The cursor stays on the item just ticked, so a second press takes it back, once the first
		// write settles (below).
		const back = press(ticked.state, "space");
		expect(doneOf(back.state)).toEqual([true, false, false]);
	});

	it("names each press for the screen to scroll into view, a fresh one every time", () => {
		const once = press(detail(), "space").state;
		expect(once.checklist.pressed).toEqual({ itemId: WRITE.id });
		const twice = press(once, "space").state;
		expect(twice.checklist.pressed).toEqual({ itemId: WRITE.id });
		expect(twice.checklist.pressed).not.toBe(once.checklist.pressed);
		// Moving the cursor is not a press; J/K reveal on their own.
		expect(press(twice, "J").state.checklist.pressed).toBe(
			twice.checklist.pressed,
		);
	});

	it("unticks a done item", () => {
		expect(keys(detail(), "K", "space").effect).toMatchObject({
			itemId: READ.id,
			done: false,
		});
	});

	it("sends one write per item at a time, queueing only the latest press", () => {
		const first = press(detail(), "space");
		expect(first.effect).toMatchObject({ itemId: WRITE.id, done: true });
		// Two more presses while it is in flight: no write of their own, the item shows the last.
		const queued = keys(first.state, "space", "space");
		expect(queued.effect).toEqual({ type: "none" });
		expect(doneOf(queued.state)).toEqual([true, true, false]);
		// The first settles on what it sent, which is what the human wants: nothing more to send.
		const settled = BoardChecklist.settle(queued.state, WRITE.id, true);
		expect(settled.effect).toEqual({ type: "none" });
		expect(doneOf(settled.state)).toEqual([true, true, false]);
	});

	// The sequence the review reproduced: open → ticked → unticked, then a poll's records taken
	// before either write landed, then the records with only the first.
	it("keeps a press over stale records until its last write settles", () => {
		const ticked = press(detail(), "space").state;
		const unticked = press(ticked, "space").state;
		expect(doneOf(unticked)).toEqual([true, false, false]);
		const stale = BoardChecklist.withOpen(unticked, "w", [READ, WRITE, DROP]);
		expect(doneOf(stale)).toEqual([true, false, false]);
		// The first write lands: the untick goes next.
		const next = BoardChecklist.settle(stale, WRITE.id, true);
		expect(next.effect).toEqual({
			type: "tickItem",
			itemId: WRITE.id,
			handle: "JREP-7.2",
			done: false,
		});
		// A poll sees the tick but not the untick: the item still shows the untick.
		const between = BoardChecklist.withOpen(next.state, "w", [
			READ,
			{ ...WRITE, done: true },
			DROP,
		]);
		expect(doneOf(between)).toEqual([true, false, false]);
		const done = BoardChecklist.settle(between, WRITE.id, true);
		expect(done.effect).toEqual({ type: "none" });
		expect(doneOf(done.state)).toEqual([true, false, false]);
		// Settled, records from after both writes say what the store holds, a tick from elsewhere
		// included: the store is at version 3 once both writes landed, and the tick makes it 4.
		const after = BoardChecklist.withOpen(done.state, "w", [
			READ,
			{ ...WRITE, done: true, version: 4 },
			DROP,
		]);
		expect(after.checklist.writes.size).toBe(0);
		expect(doneOf(after)).toEqual([true, true, false]);
	});

	// The sequence the closing review found: a poll's fetch begins before the tick, the tick
	// settles, and that poll lands after it.
	it("keeps a settled press over records read before its write, until records that agree land", () => {
		const ticked = press(detail(), "space").state;
		const settled = BoardChecklist.settle(ticked, WRITE.id, true).state;
		const stale = BoardChecklist.withOpen(settled, "w", [READ, WRITE, DROP]);
		expect(stale.checklist.writes.get(WRITE.id)?.wanted).toBe(true);
		expect(doneOf(stale)).toEqual([true, true, false]);
		const agreed = BoardChecklist.withOpen(stale, "w", [
			READ,
			{ ...WRITE, done: true, version: 2 },
			DROP,
		]);
		expect(agreed.checklist.writes.size).toBe(0);
		expect(doneOf(agreed)).toEqual([true, true, false]);
	});

	it("puts an item back to its last acknowledged state when its write fails, dropping what was queued", () => {
		// WRITE ticked and acknowledged, then unticked and ticked again behind a write that fails.
		const ticked = press(detail(), "space").state;
		const acked = BoardChecklist.settle(ticked, WRITE.id, true).state;
		const untick = press(acked, "space");
		expect(untick.effect).toMatchObject({ itemId: WRITE.id, done: false });
		const queued = press(untick.state, "space").state;
		// DROP has a write of its own in flight.
		const other = keys(queued, "J", "space").state;
		const failed = BoardChecklist.settle(other, WRITE.id, false);
		expect(failed.effect).toEqual({ type: "none" });
		expect(doneOf(failed.state)).toEqual([true, true, true]);
		expect(failed.state.checklist.writes.get(DROP.id)?.sending).toBe(true);
		// A failure from a first press goes back to the records' state.
		const lone = BoardChecklist.settle(
			press(detail(), "space").state,
			WRITE.id,
			false,
		);
		expect(doneOf(lone.state)).toEqual([true, false, false]);
	});

	it("keeps a write in flight when its issue's detail closes, so its outcome still lands", () => {
		const ticked = press(detail(), "space").state;
		const closed = BoardChecklist.withOpen(
			{ ...ticked, view: { type: "board" } },
			null,
		);
		expect(closed.checklist.writes.get(WRITE.id)?.sending).toBe(true);
		expect(
			BoardChecklist.settle(closed, WRITE.id, true).state.checklist.writes.get(
				WRITE.id,
			)?.sending,
		).toBeNull();
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
