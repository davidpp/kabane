// The checklists agents and the CLI keep on issues (`@cabane/checklist`), as plain functions over the
// board's state beside decisions.ts. Two surfaces:
//
// - Each card with items says how far they have got, `· 3/5`, from one progress query per poll.
// - An issue's detail lists its items first on its `now` tab with a cursor on one: `J/K` move it and
//   `space` ticks or unticks it. The cursor starts on the first open item, where a loop resumes.
//   The same cursor walks on past the items to the subtasks and linked issues listed under them
//   (DetailModel.openable), where `enter` opens the one under it (BoardNav's detail keys). With no
//   items, it starts on the first of those.
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
		// The open detail view's task, its live items in list order and the rows after them the cursor
		// can open, as of its last records.
		open: {
			taskId: string;
			items: readonly ChecklistItemView[];
			rows: readonly DetailModel.OpenableRow[];
		} | null;
		// The item or row `J/K` put the cursor on, by item id or row key; null leaves it on the first
		// open item, else the first row.
		cursor: string | null;
		// The items this board is writing, by item id.
		writes: ReadonlyMap<string, Write>;
		// The item last toggled, a fresh object per press: the screen scrolls its row into view, so
		// `space` on an item scrolled off shows what it changed in the same press.
		pressed: { itemId: string } | null;
	};

	/**
	 * One item's writes from this board. `wanted` is what it shows: the human's last press. `sending`
	 * is the state in flight to the store, null once nothing is. `acked` is the state the store last
	 * acknowledged, where a failed write puts the item back. `version` is the item's version once the
	 * store has applied every write sent: records older than that were read before the last write
	 * landed, so a settled entry outlasts them (see `standing`).
	 */
	type Write = {
		handle: string;
		wanted: boolean;
		sending: boolean | null;
		acked: boolean;
		version: number;
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

	/**
	 * The id of a cursor row in the detail view, an item's by its id or a subtask's or link's by its
	 * key, which `reveal` scrolls into view.
	 */
	export const rowId = (key: string): string => `checklist-${key}`;

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
		// The rows after the items the cursor walks on to, in order.
		rows: readonly DetailModel.OpenableRow[];
		// The item `space` toggles, or the row `enter` opens: an item's id or a row's key.
		cursor: string | undefined;
		progress: ChecklistProgress;
	};

	/**
	 * Items as drawn: `writes` over the records, the cursor where `J/K` left it, else on the first
	 * open item, else the first item, else the first row.
	 */
	export const view = (
		items: readonly ChecklistItemView[],
		cursor: string | null = null,
		writes: ReadonlyMap<string, Write> = new Map(),
		rows: readonly DetailModel.OpenableRow[] = [],
	): Shown => {
		const lines = items.map((item) => ({
			id: item.id,
			handle: item.handle,
			text: item.text,
			done: writes.get(item.id)?.wanted ?? item.done,
		}));
		const at =
			lines.find((line) => line.id === cursor)?.id ??
			rows.find((row) => row.key === cursor)?.key ??
			lines.find((line) => !line.done)?.id ??
			lines[0]?.id ??
			rows[0]?.key;
		return {
			lines,
			rows,
			cursor: at,
			progress: {
				done: lines.filter((line) => line.done).length,
				total: lines.length,
			},
		};
	};

	// The writes new records cannot override: one still in flight or queued, and one settled whose
	// item these records show otherwise from before its last write, as a poll that began before the
	// write lands after it. Records that agree with it, or carry a later change, end a settled one.
	const standing = (
		writes: ReadonlyMap<string, Write>,
		items: readonly ChecklistItemView[],
	): ReadonlyMap<string, Write> =>
		new Map(
			[...writes].filter(([id, write]) => {
				if (write.sending !== null) return true;
				const item = items.find((i) => i.id === id);
				return (
					item !== undefined &&
					item.done !== write.wanted &&
					item.version < write.version
				);
			}),
		);

	/**
	 * The detail view's records, as far as the cursor goes: `items` are the task's, or none when no
	 * task is open, and `rows` what it lists after them to open. Another task starts its cursor over. A write in flight is kept whichever task is
	 * open, since its outcome still lands; a settled one gives way to these records once they are
	 * not older than it.
	 */
	export const withOpen = (
		state: State,
		taskId: string | null,
		items: readonly ChecklistItemView[] = [],
		rows: readonly DetailModel.OpenableRow[] = [],
	): State => {
		const writes = standing(state.checklist.writes, items);
		if (taskId === null)
			return state.checklist.open === null
				? state
				: patch(state, { open: null, cursor: null, writes, pressed: null });
		const same = state.checklist.open?.taskId === taskId;
		return patch(state, {
			open: { taskId, items, rows },
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
					version: write.version - 1,
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
				version: write.version + 1,
			}),
			effect: {
				type: "tickItem",
				itemId,
				handle: write.handle,
				done: write.wanted,
			},
		};
	};

	/**
	 * The open detail view's checklist and the rows after it, while its records are this task's and
	 * the cursor has anything to stand on.
	 */
	export const shown = (state: State): Shown | undefined => {
		const { view: on } = state;
		const { open, cursor, writes } = state.checklist;
		if (on.type !== "detail" || open?.taskId !== on.taskId) return undefined;
		if (open.items.length + open.rows.length === 0) return undefined;
		return view(open.items, cursor, writes, open.rows);
	};

	/** The cursor the keys act on: drawn on the `now` tab, with the board holding the keys. */
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

	const onItem = (asked: Shown): boolean =>
		asked.lines.some((line) => line.id === asked.cursor);

	/**
	 * What the footer can offer on `now`: `J/K` while the cursor has rows to walk, `space` while it
	 * is on an item, `enter` while it is on a subtask or linked issue.
	 */
	export const situation = (
		state: State,
	): { cursor: boolean; checklist: boolean; openable: boolean } => {
		const asked = inHand(state);
		return {
			cursor: asked !== undefined,
			checklist: asked !== undefined && onItem(asked),
			openable: target(state) !== undefined,
		};
	};

	/** The issue under the cursor, which `enter` opens; none while the cursor is on an item. */
	export const target = (state: State): string | undefined => {
		const asked = inHand(state);
		return asked?.rows.find((row) => row.key === asked.cursor)?.taskId;
	};

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
		const record = state.checklist.open?.items.find((item) => item.id === id);
		return {
			state: withWrite(at, id, {
				handle: line.handle,
				wanted: done,
				sending: done,
				acked: write?.acked ?? record?.done ?? line.done,
				// A settled write's own count stands when the open records are older than it.
				version: Math.max(write?.version ?? 0, record?.version ?? 0) + 1,
			}),
			effect: { type: "tickItem", itemId: id, handle: line.handle, done },
		};
	};

	// `J/K`: the cursor one row down or up, items then the rows after them, stopping at either end,
	// and its row scrolled into view.
	const move = (state: State, asked: Shown, delta: number): Step => {
		const keys = [
			...asked.lines.map((line) => line.id),
			...asked.rows.map((row) => row.key),
		];
		const next = keys[keys.indexOf(asked.cursor ?? "") + delta];
		if (next === undefined) return { state, effect: NOTHING };
		return {
			state: patch(state, { cursor: next }),
			effect: { type: "reveal", id: rowId(next) },
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
		if (key.name === "space" && asked.cursor && onItem(asked))
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
