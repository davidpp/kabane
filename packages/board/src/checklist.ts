// The checklists agents and the CLI keep on issues (`@cabane/checklist`), as plain functions over the
// board's state beside decisions.ts. Two surfaces:
//
// - Each card with items says how far they have got, `· 3/5`, from one progress query per poll.
// - An issue's detail lists its items in the description tab with a cursor on one: `J/K` move it and
//   `space` ticks or unticks it. The cursor starts on the first open item, where a loop resumes.
//
// A checklist write leaves the task row alone, so nothing on the row says it changed: the poll reads
// the progress beside the rows every time, and the open detail's stamp counts the items
// (BoardData.detailStamp), so a tick made from the CLI or by an agent shows within one poll. A tick
// made here shows at once: `flipped` holds what the human pressed until the records say the same,
// and a failed write takes it back.
import type { ChecklistItemView, ChecklistProgress } from "@cabane/checklist";
import { DetailModel } from "./detail-model";
import type { BoardNav } from "./nav";

export namespace BoardChecklist {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	export type Checklist = {
		// Done and total items by task id, over the whole tracker, as of the last poll.
		progress: ReadonlyMap<string, ChecklistProgress>;
		// The open detail view's task and its live items, in list order, as of its last records.
		open: { taskId: string; items: readonly ChecklistItemView[] } | null;
		// The item `J/K` put the cursor on; null leaves it on the first open one.
		cursor: string | null;
		// Ticked or unticked from this board, the write still landing: item id to the state pressed.
		flipped: ReadonlyMap<string, boolean>;
	};

	export const NONE: Checklist = {
		progress: new Map(),
		open: null,
		cursor: null,
		flipped: new Map(),
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	const patch = (state: State, next: Partial<Checklist>): State => ({
		...state,
		checklist: { ...state.checklist, ...next },
	});

	/** The id of an item's row in the detail view, which `reveal` scrolls into view. */
	export const rowId = (itemId: string): string => `checklist-${itemId}`;

	// ── the board ───────────────────────────────────────────────────────────────────────────────

	/** The poll's progress; the same state when it read none. */
	export const withProgress = (
		state: State,
		progress: ReadonlyMap<string, ChecklistProgress> | undefined,
	): State => (progress ? patch(state, { progress }) : state);

	/** A card's `· 3/5`, or nothing for a task with no items. */
	export const badge = (progress: ChecklistProgress | undefined): string =>
		progress && progress.total > 0
			? ` · ${progress.done}/${progress.total}`
			: "";

	// ── the detail view ─────────────────────────────────────────────────────────────────────────

	/** One item as the detail view draws it, with what this board pressed on it already applied. */
	export type Line = {
		id: string;
		handle: string;
		text: string;
		done: boolean;
	};

	export type Shown = {
		lines: readonly Line[];
		// The item `space` toggles.
		cursor: string | undefined;
		progress: ChecklistProgress;
	};

	/** Items as drawn: `flipped` over the records, the cursor where `J/K` left it or the first open one. */
	export const view = (
		items: readonly ChecklistItemView[],
		cursor: string | null = null,
		flipped: ReadonlyMap<string, boolean> = new Map(),
	): Shown => {
		const lines = items.map((item) => ({
			id: item.id,
			handle: item.handle,
			text: item.text,
			done: flipped.get(item.id) ?? item.done,
		}));
		const at =
			lines.find((line) => line.id === cursor) ??
			lines.find((line) => !line.done) ??
			lines[0];
		return {
			lines,
			cursor: at?.id,
			progress: {
				done: lines.filter((line) => line.done).length,
				total: lines.length,
			},
		};
	};

	/**
	 * The detail view's records, as far as the checklist goes: `items` are the task's, or none when no
	 * task is open. Another task starts its cursor over; a press the records now agree with, or on an
	 * item gone, is dropped.
	 */
	export const withOpen = (
		state: State,
		taskId: string | null,
		items: readonly ChecklistItemView[] = [],
	): State => {
		if (taskId === null)
			return state.checklist.open === null
				? state
				: patch(state, { open: null, cursor: null, flipped: new Map() });
		const same = state.checklist.open?.taskId === taskId;
		const flipped = new Map(
			[...state.checklist.flipped].filter(([id, done]) =>
				items.some((item) => item.id === id && item.done !== done),
			),
		);
		return patch(state, {
			open: { taskId, items },
			cursor: same ? state.checklist.cursor : null,
			flipped,
		});
	};

	/** The write failed: the item shows what the records say again. */
	export const withFailed = (state: State, itemId: string): State => {
		const flipped = new Map(state.checklist.flipped);
		return flipped.delete(itemId) ? patch(state, { flipped }) : state;
	};

	/** The open detail view's checklist, while its records are this task's and it has items. */
	export const shown = (state: State): Shown | undefined => {
		const { view: on } = state;
		const { open, cursor, flipped } = state.checklist;
		if (on.type !== "detail" || open?.taskId !== on.taskId) return undefined;
		if (open.items.length === 0) return undefined;
		return view(open.items, cursor, flipped);
	};

	/** The checklist the keys act on: drawn on the description tab, with the board holding the keys. */
	const inHand = (state: State): Shown | undefined =>
		state.focus === "board" &&
		!state.prompt.open &&
		state.view.type === "detail" &&
		(state.view.tab ?? DetailModel.DEFAULT_TAB) === "description"
			? shown(state)
			: undefined;

	/** Whether `space` and `J/K` have an item to act on, for the footer. */
	export const listed = (state: State): boolean => inHand(state) !== undefined;

	// `space` on the item under the cursor: it flips at once, and the write follows.
	const toggle = (state: State, asked: Shown, id: string): Step => {
		const line = asked.lines.find((l) => l.id === id);
		if (!line) return { state, effect: NOTHING };
		const done = !line.done;
		return {
			state: patch(state, {
				cursor: id,
				flipped: new Map([...state.checklist.flipped, [id, done]]),
			}),
			effect: { type: "tickItem", itemId: id, handle: line.handle, done },
		};
	};

	// `J/K`: the cursor one item down or up, stopping at either end, and its row scrolled into view.
	const move = (state: State, asked: Shown, delta: number): Step => {
		const at = asked.lines.findIndex((line) => line.id === asked.cursor);
		const next = asked.lines[at + delta];
		if (!next) return { state, effect: NOTHING };
		return {
			state: patch(state, { cursor: next.id }),
			effect: { type: "reveal", id: rowId(next.id) },
		};
	};

	// Shifted letters, like `O` and `A`: terminals disagree on the name, so match it or the sequence.
	const isKey = (key: BoardNav.KeyInput, letter: string): boolean =>
		!key.ctrl && !key.meta && (key.name === letter || key.sequence === letter);

	/** A key on the checklist in hand, ahead of the detail view's own. Null for any other key. */
	export const reduceKey = (
		state: State,
		key: BoardNav.KeyInput,
	): Step | null => {
		const asked = inHand(state);
		if (!asked || key.ctrl || key.meta) return null;
		if (key.name === "space" && asked.cursor)
			return toggle(state, asked, asked.cursor);
		if (isKey(key, "J")) return move(state, asked, 1);
		if (isKey(key, "K")) return move(state, asked, -1);
		return null;
	};

	/** A click on an item's row: the cursor goes there and the item flips, as `space` would. */
	export const click = (state: State, itemId: string): Step => {
		const asked = inHand(state);
		return asked ? toggle(state, asked, itemId) : { state, effect: NOTHING };
	};
}
