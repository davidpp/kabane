// The checklists agents and the CLI keep on issues (`@cabane/checklist`), as plain functions over the
// board's state beside decisions.ts. Two surfaces:
//
// - Each card with items says how far they have got, `· 3/5`, from one progress query per poll.
// - An issue's detail lists its items first on its `now` tab with a cursor on one: `J/K` move it and
//   `space` ticks or unticks it. The cursor starts on the first open item, where a loop resumes.
//
// A checklist write leaves the task row alone, so nothing on the row says it changed: the poll reads
// the progress beside the rows every time, and the open detail's stamp counts the items
// (BoardData.detailStamp), so a tick made from the CLI or by an agent shows within one poll.
//
// A tick made here shows at once, and its writes go one at a time per item (`writes`): while one is
// in flight, another press only changes what is queued, and the latest intent goes when it settles.
// Until then the item shows what the human pressed, whatever a poll's records say: a snapshot taken
// before the store caught up cannot take a press back. A failed write puts the item back to the
// state the store last acknowledged and drops what was queued behind it.
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
		// The items this board is writing, by item id.
		writes: ReadonlyMap<string, Write>;
		// The item last toggled, a fresh object per press: the screen scrolls its row into view, so
		// `space` on an item scrolled off shows what it changed in the same press.
		pressed: { itemId: string } | null;
	};

	/**
	 * One item's writes from this board. `wanted` is what it shows: the human's last press. `sending`
	 * is the state in flight to the store, null once nothing is (the entry then lasts until the next
	 * records, so a poll that started before the write cannot flash the old state). `acked` is the
	 * state the store last acknowledged, where a failed write puts the item back.
	 */
	type Write = {
		handle: string;
		wanted: boolean;
		sending: boolean | null;
		acked: boolean;
	};

	export const NONE: Checklist = {
		progress: new Map(),
		open: null,
		cursor: null,
		writes: new Map(),
		pressed: null,
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

	/** Items as drawn: `writes` over the records, the cursor where `J/K` left it or the first open one. */
	export const view = (
		items: readonly ChecklistItemView[],
		cursor: string | null = null,
		writes: ReadonlyMap<string, Write> = new Map(),
	): Shown => {
		const lines = items.map((item) => ({
			id: item.id,
			handle: item.handle,
			text: item.text,
			done: writes.get(item.id)?.wanted ?? item.done,
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

	// The writes still in flight or queued: what new records cannot override. One settled has had
	// its records by now, which say what the store holds.
	const unsettled = (
		writes: ReadonlyMap<string, Write>,
	): ReadonlyMap<string, Write> =>
		new Map([...writes].filter(([, write]) => write.sending !== null));

	/**
	 * The detail view's records, as far as the checklist goes: `items` are the task's, or none when no
	 * task is open. Another task starts its cursor over. A write in flight is kept whichever task is
	 * open, since its outcome still lands; a settled one gives way to these records.
	 */
	export const withOpen = (
		state: State,
		taskId: string | null,
		items: readonly ChecklistItemView[] = [],
	): State => {
		const writes = unsettled(state.checklist.writes);
		if (taskId === null)
			return state.checklist.open === null
				? state
				: patch(state, { open: null, cursor: null, writes, pressed: null });
		const same = state.checklist.open?.taskId === taskId;
		return patch(state, {
			open: { taskId, items },
			cursor: same ? state.checklist.cursor : null,
			writes,
		});
	};

	const withWrite = (state: State, id: string, write: Write | null): State => {
		const writes = new Map(state.checklist.writes);
		if (write) writes.set(id, write);
		else writes.delete(id);
		return patch(state, { writes });
	};

	/**
	 * The write in flight for `itemId` settled. On success the store holds what was sent, and the
	 * latest press goes next when it differs; on failure the item goes back to the state the store
	 * last acknowledged and what was queued is dropped. Other items' writes are left alone.
	 */
	export const settle = (state: State, itemId: string, ok: boolean): Step => {
		const write = state.checklist.writes.get(itemId);
		if (write?.sending == null) return { state, effect: NOTHING };
		if (!ok)
			return {
				state: withWrite(state, itemId, {
					...write,
					wanted: write.acked,
					sending: null,
				}),
				effect: NOTHING,
			};
		const acked = write.sending;
		if (write.wanted === acked)
			return {
				state: withWrite(state, itemId, { ...write, acked, sending: null }),
				effect: NOTHING,
			};
		return {
			state: withWrite(state, itemId, {
				...write,
				acked,
				sending: write.wanted,
			}),
			effect: {
				type: "tickItem",
				itemId,
				handle: write.handle,
				done: write.wanted,
			},
		};
	};

	/** The open detail view's checklist, while its records are this task's and it has items. */
	export const shown = (state: State): Shown | undefined => {
		const { view: on } = state;
		const { open, cursor, writes } = state.checklist;
		if (on.type !== "detail" || open?.taskId !== on.taskId) return undefined;
		if (open.items.length === 0) return undefined;
		return view(open.items, cursor, writes);
	};

	/** The checklist the keys act on: drawn on the `now` tab, with the board holding the keys. */
	const inHand = (state: State): Shown | undefined =>
		state.focus === "board" &&
		!state.prompt.open &&
		state.view.type === "detail" &&
		(state.view.tab ?? DetailModel.DEFAULT_TAB) === "now"
			? shown(state)
			: undefined;

	/**
	 * The cursor's row while the `now` tab draws the checklist, and the task it is drawn for. The
	 * screen scrolls the row into view when that task's `now` comes on screen, by a switch of tab or
	 * when its records land, so the item `space` would toggle is in sight. A scroll or a poll leaves
	 * the task the same and moves nothing: the cursor never pulls the view after it on its own.
	 */
	export const onScreen = (
		state: State,
	): { taskId: string; rowId: string } | null => {
		const asked = shown(state);
		if (
			!asked?.cursor ||
			state.view.type !== "detail" ||
			(state.view.tab ?? DetailModel.DEFAULT_TAB) !== "now"
		)
			return null;
		return { taskId: state.view.taskId, rowId: rowId(asked.cursor) };
	};

	/** Whether `space` and `J/K` have an item to act on, for the footer. */
	export const listed = (state: State): boolean => inHand(state) !== undefined;

	// `space` on the item under the cursor: it flips at once. With no write of its own in flight the
	// write goes now; with one, the press waits behind it (settle sends the latest).
	const toggle = (state: State, asked: Shown, id: string): Step => {
		const line = asked.lines.find((l) => l.id === id);
		if (!line) return { state, effect: NOTHING };
		const done = !line.done;
		const at = patch(state, { cursor: id, pressed: { itemId: id } });
		const write = state.checklist.writes.get(id);
		if (write && write.sending !== null)
			return {
				state: withWrite(at, id, { ...write, wanted: done }),
				effect: NOTHING,
			};
		const stored =
			state.checklist.open?.items.find((item) => item.id === id)?.done ??
			line.done;
		return {
			state: withWrite(at, id, {
				handle: line.handle,
				wanted: done,
				sending: done,
				acked: write?.acked ?? stored,
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
