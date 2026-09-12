// Pure interaction core for the board: selection + expansion + filter state and the key/mouse routers
// live here as plain functions so they're unit-testable without a renderer (the issue's preferred seam
// over key-injection frame tests). app.tsx owns the single useKeyboard handler and runs the Effects
// these return; it never mutates board state directly.
import {
	type ItemKind,
	TASK_STATE_DISPLAY,
	type Task,
	type TaskState,
} from "@cabane/core";
import { CopilotLog } from "./copilot-log";
import { BoardData } from "./data";
import type {
	CopilotPermission,
	CopilotShortcut,
	TriggerDescriptor,
} from "./ports";

export namespace BoardNav {
	export type KindFilter = "all" | ItemKind;

	// The second cycling filter (`f`), on the state/flag axis rather than the kind one. `open` is what
	// the board has always shown — the four open sections, done left to search. `done` swaps to the
	// archive section alone. `review` spans every section and keeps only the needsReview rows: an agent
	// marks an issue done and flags it, so "done AND needs review" is the human's real inbox and has to
	// stay askable — which is why review composes over the states instead of being a third bucket.
	export type StatusFilter = "open" | "done" | "review";

	// Transient footer feedback (copy result, state moves, review/cancel). Auto-cleared by app.tsx after a
	// short flash; "never silent" — every mutation and every copy surfaces one. Owned here because the key
	// reducer is what decides when a notice fires (e.g. the `v` no-op). `undoable` is set by app.tsx (not
	// the reducer) on the success flashes of pushed mutations — the footer then appends the ⌃z hint and
	// app.tsx holds the flash longer.
	export type Notice = {
		text: string;
		tone: "success" | "error";
		undoable?: boolean;
	};

	// The view stack: the board is always the base; `enter` pushes a detail view for the selected task
	// on top. Modeled as a discriminated `view` (not a flat `detailOpen` boolean) so `esc` pops exactly
	// one level — from detail back to the board — WITHOUT the same press also widening scope.
	export type BoardView =
		| { type: "board" }
		| { type: "detail"; taskId: string }
		| {
				type: "events";
				cardId: string;
				fromView: "board" | "detail";
				fromTaskId?: string;
		  };

	// Vim-style `/` search over the loaded board. `typing` is input mode (the footer shows the query,
	// every other board key is inert — printable chars go to the query); `enter` commits to `committed`
	// where normal keys work again over the filtered list. The filter itself lives in visibleRows so
	// selection, mouse addressing, and scroll-into-view all agree on the same rows.
	export type SearchState =
		| { mode: "off" }
		| { mode: "typing"; query: string }
		| { mode: "committed"; query: string };

	// The key event the reducer accepts. `name` is the parsed key name (existing behavior); `sequence`
	// is the raw printable sequence OpenTUI's ParsedKey carries — in search-typing mode single printable
	// chars append to the query. Optional + structural so ParsedKey passes straight through from the one
	// useKeyboard handler in app.tsx and existing `{ name }` test calls keep compiling.
	export type KeyInput = {
		name: string;
		sequence?: string;
		ctrl?: boolean;
		meta?: boolean;
		// ⇧tab: terminals send `\x1b[Z`, which the parser names `tab` with this set.
		shift?: boolean;
	};

	// The `a` dispatch overlay: a single-step picker over the host Dispatcher's triggers for one task.
	// Opens in `loading` while the host lists them; while open it owns the keyboard (same modal
	// discipline as search-typing).
	export type DispatchOverlay = {
		taskId: string;
		triggers: TriggerDescriptor[];
		selected: number;
		loading: boolean;
	};

	// Where the copilot's turn is, as far as the keyboard cares: `running` gates a second prompt and
	// enables cancel; `done`/`error` keep the footer indicator up until the next keypress, which is
	// what `idle` means. The transcript itself lives in app.tsx (CopilotLog), not here.
	export type CopilotTurn = "idle" | "running" | "done" | "error";

	export type CopilotState = {
		// A MIRROR of the textarea's buffer, not the source of truth — app.tsx pushes it here on every
		// content change so `/` matching and the collapsed row's draft hint see what the human sees.
		text: string;
		// Prompts sent this session, oldest first; `up` in an empty buffer walks back through them.
		history: readonly string[];
		// How far back the walk is, counted from the END so a new prompt does not shift it. 0 = out.
		historyAt: number;
		turn: CopilotTurn;
		// From the host's `Copilot.shortcuts()`, set once by app.tsx; the `/` expansions.
		shortcuts: readonly CopilotShortcut[];
		// The actor uri the copilot's writes are stamped with, likewise set once. Null for a host
		// copilot that names none.
		actor: string | null;
		// The request the harness is blocked on, if any. Set from the stream, cleared the moment it
		// is answered or the turn stops running — never by a timeout and never by the board picking
		// an option, which is the whole point of carrying it this far.
		permission: CopilotPermission | null;
	};

	// `?` is a shifted key: terminals deliver it as a printable sequence and parsers disagree on the
	// `name`, so the router matches either. Search-typing never sees this (its branch runs first and
	// eats `?` as a query character).
	const isHelpKey = (key: KeyInput): boolean =>
		!key.ctrl && !key.meta && (key.name === "?" || key.sequence === "?");

	// `A` and `:` are shifted keys like `?`: match the name or the raw sequence. Search-typing never
	// sees this (its branch runs first and eats both as query characters).
	const isCopilotKey = (key: KeyInput): boolean =>
		!key.ctrl &&
		!key.meta &&
		(key.name === "A" ||
			key.sequence === "A" ||
			key.name === ":" ||
			key.sequence === ":");

	// ctrl-z: OpenTUI delivers it as name `z` with the ctrl flag, or as the raw SUB control char (0x1a);
	// match either. `!key.meta` excludes macOS cmd-z. Routing guards on search-typing so it stays inert
	// while a `/` query is being entered.
	const isUndoKey = (key: KeyInput): boolean =>
		!!key.ctrl && !key.meta && (key.name === "z" || key.sequence === "\x1a");

	// Selection is by task id (not an index) so it survives the 5s poll reload — the same task stays
	// selected even when the list reshuffles. `expanded` is the set of expanded parent ids, likewise
	// preserved across reloads. `scoped` gates the project-scope filter — `esc` flips it off to widen
	// to all scopes. `view` is the top of the view stack.
	// Which pane has the keyboard. One ring for the whole board: which view is on screen does not
	// change what `tab` means.
	export type Focus = "board" | "copilot" | "sidebar";

	export type SidebarState = {
		visible: boolean;
		selected: number;
		/** Total sidebar items — updated by app.tsx when activity loads. The reducer uses this
		 *  for j/k bounds; render clamps if it drifts. */
		itemCount: number;
	};

	// Reverse patch — the subset of task fields any board mutation can change. Applied verbatim through
	// Planner.updateTask to walk a task back to its pre-mutation values.
	export type UndoPatch = Partial<
		Pick<Task, "state" | "needsReview" | "verification">
	>;
	// One entry on the undo stack: the reverse patch plus the copy the footer flashes on undo.
	export type UndoEntry = {
		id: string;
		shortId: string;
		patch: UndoPatch;
		label: string;
	};

	export type BoardState = {
		sections: BoardData.BoardSection[];
		selectedId: string | null;
		expanded: ReadonlySet<string>;
		kind: KindFilter;
		status: StatusFilter;
		scoped: boolean;
		view: BoardView;
		search: SearchState;
		dispatch: DispatchOverlay | null;
		// The `?` help overlay (full keybinding list; footers show only the app-specific subset).
		// A boolean modal flag, same lifecycle as `dispatch`: owns the keyboard while open.
		help: boolean;
		focus: Focus;
		sidebar: SidebarState;
		// The working set: task ids toggled with `m`, in mark order (a Set keeps insertion order, and
		// the copilot's context drops the OLDEST mark first when its brief budget runs out). Survives
		// every reload; `esc` clears it before it clears anything else.
		marked: ReadonlySet<string>;
		copilot: CopilotState;
		// Bounded, in-memory (per board session), LIFO stack of reverse patches. Pushed OPTIMISTICALLY at
		// reduce time — mutations to local SQLite essentially never fail, and a failed forward write leaves
		// its reverse patch a harmless no-op (the field is already at the prior value). Preserved across
		// every reload (withSections/withSearchResults spread it through). No redo.
		undo: readonly UndoEntry[];
	};

	// A single rendered line: a top-level task (depth 0) or one of its subtasks (depth 1). `hasChildren`
	// and `expanded` drive the tree caret; `parentId` lets `h` on a child jump to its parent.
	export type VisibleRow = {
		task: Task;
		depth: 0 | 1;
		parentId: string | null;
		hasChildren: boolean;
		expanded: boolean;
	};

	// What app.tsx must do after an action. Pure nav produces `none`; filter/scope changes need a reload
	// (they change the query); `[`/`]`/`d`/`x`/`n`/`s`/`v` map to the BoardData mutations, each followed
	// by a reload; `scroll` drives the detail view's scrollbox (app.tsx holds the ref). Mutation effects
	// carry the success `notice` text the reducer composed (it has the shortId); app.tsx flashes it on
	// success and the error message on failure. `notice` is a standalone flash with no mutation (the `v`
	// no-op when there is no review flag).
	export type Effect =
		| { type: "none" }
		| { type: "quit" }
		| { type: "reload" }
		| { type: "setState"; id: string; state: TaskState; notice: string }
		| { type: "markDone"; id: string; notice: string }
		| { type: "markReviewed"; id: string; notice: string }
		| { type: "applyUndo"; id: string; patch: UndoPatch; notice: string }
		| { type: "scroll"; delta: number }
		| { type: "copy"; id: string }
		| { type: "notice"; notice: Notice }
		| { type: "dispatch"; triggerId: string; id: string }
		| { type: "loadTriggers"; taskId: string }
		| { type: "sidebarSelect" }
		| { type: "openEvents"; taskId: string }
		// The window just opened; app.tsx closes it with a flash when no copilot is configured.
		| { type: "copilotOpen" }
		| { type: "copilotPrompt"; prompt: string }
		// Push a whole new value into the textarea, which owns the buffer: expand, recall, clear.
		| { type: "copilotSetText"; text: string }
		| { type: "copilotCancel" }
		// The human picked an option for the blocked harness, or declined with `null`.
		| { type: "copilotAnswer"; id: string; optionId: string | null };

	// Mouse actions routed through the SAME pure reducer as keys, so selection stays single-sourced.
	// Rows are addressed by their VISIBLE index (see visibleRows) — the wheel no longer moves selection
	// (the scrollbox scrolls the viewport natively), so there is no scroll action here.
	export type MouseAction =
		| { type: "select"; row: number }
		| { type: "toggleExpand"; row: number }
		| { type: "copy" };

	const NONE: Effect = { type: "none" };
	const SEARCH_OFF: SearchState = { mode: "off" };
	const KIND_CYCLE = ["all", "issue", "task"] as const satisfies KindFilter[];
	const STATUS_CYCLE = [
		"open",
		"done",
		"review",
	] as const satisfies StatusFilter[];
	// Bounded undo depth — a mis-press safety net, not an edit history.
	const UNDO_CAP = 20;

	// Append an entry, dropping the oldest once the cap is exceeded (LIFO stack, bounded).
	const pushUndo = (
		stack: readonly UndoEntry[],
		entry: UndoEntry,
	): readonly UndoEntry[] => {
		const next = [...stack, entry];
		return next.length > UNDO_CAP ? next.slice(next.length - UNDO_CAP) : next;
	};

	// Push an undo entry onto the state's bounded stack.
	const withUndo = (state: BoardState, entry: UndoEntry): BoardState => ({
		...state,
		undo: pushUndo(state.undo, entry),
	});

	// `m`: add or drop one task from the working set. Pure; no effect — marks are board state only.
	const toggleMark = (
		state: BoardState,
		id: string | undefined,
	): { state: BoardState; effect: Effect } => {
		if (!id) return { state, effect: NONE };
		const marked = new Set(state.marked);
		if (!marked.delete(id)) marked.add(id);
		return { state: { ...state, marked }, effect: NONE };
	};

	const NO_MARKS: ReadonlySet<string> = new Set<string>();

	// Prompts kept for `up` recall. A session buffer, not persistence.
	const HISTORY_CAP = 50;

	const COPILOT_IDLE: CopilotState = {
		text: "",
		history: [],
		historyAt: 0,
		turn: "idle",
		shortcuts: [],
		actor: null,
		permission: null,
	};

	const withCopilot = (
		state: BoardState,
		copilot: Partial<CopilotState>,
	): BoardState => ({ ...state, copilot: { ...state.copilot, ...copilot } });

	// Called by app.tsx as the turn's log changes. Pure so the footer rule (indicator up until the next
	// keypress) is testable: the reducer, not app.tsx, is what moves `done`/`error` back to `idle`.
	// A turn that has stopped — finished, failed, or acknowledged — can have nothing waiting on the
	// human: there is no longer a harness on the other end to hear the answer.
	export const withCopilotTurn = (
		state: BoardState,
		turn: CopilotTurn,
	): BoardState =>
		state.copilot.turn === turn && state.copilot.permission === null
			? state
			: withCopilot(state, { turn, permission: null });

	// The harness asked something mid-turn, or its question has just been answered.
	export const withCopilotPermission = (
		state: BoardState,
		permission: CopilotPermission | null,
	): BoardState => withCopilot(state, { permission });

	// What the host's copilot says about itself, read once by app.tsx when the board opens: the `/`
	// expansions it offers and the actor uri its writes carry.
	export const withCopilotPort = (
		state: BoardState,
		port: { shortcuts: readonly CopilotShortcut[]; actor: string | null },
	): BoardState => withCopilot(state, port);

	// The rows the copilot itself changed during the turn in hand: stamped with its actor uri and
	// updated since the turn opened (`since` is the turn's start, which app.tsx reads off the log).
	// Empty while the copilot is idle, and `turn` returns to `idle` on the next keypress — so the
	// press that dismisses the footer indicator clears these glyphs too, rather than the board
	// carrying two notions of "you have seen this".
	export const copilotTouched = (
		state: BoardState,
		since: string | undefined,
	): ReadonlySet<string> => {
		const { actor, turn } = state.copilot;
		if (turn === "idle" || !actor || !since) return NO_MARKS;
		const touched = new Set<string>();
		for (const section of state.sections)
			for (const { task, children } of section.rows)
				for (const row of [task, ...children])
					if (row.updatedBy === actor && row.updatedAt >= since)
						touched.add(row.id);
		return touched;
	};

	// The ring, in tab order. The sidebar drops out of it when hidden (`b`, or a terminal too narrow
	// for it) — tab must never move focus somewhere the human cannot see.
	const RING: readonly Focus[] = ["board", "copilot", "sidebar"];

	const focusable = (state: BoardState): Focus[] =>
		RING.filter((pane) => pane !== "sidebar" || state.sidebar.visible);

	// `delta` is +1 for tab, -1 for ⇧tab. A focus that has left the ring (the sidebar was just
	// hidden) lands on the board, which is always in it.
	const cycleFocus = (state: BoardState, delta: 1 | -1): BoardState => {
		const ring = focusable(state);
		const at = ring.indexOf(state.focus);
		const next = ring[(at + delta + ring.length) % ring.length] ?? "board";
		return next === state.focus ? state : { ...state, focus: next };
	};

	// `b`: show or hide the sidebar. Focus cannot rest on a pane that is gone.
	const toggleSidebar = (state: BoardState): BoardState => {
		const visible = !state.sidebar.visible;
		return {
			...state,
			sidebar: { ...state.sidebar, visible },
			focus: !visible && state.focus === "sidebar" ? "board" : state.focus,
		};
	};

	// `A`/`:`: jump straight to the copilot from anywhere. Optimistic like the dispatch overlay —
	// app.tsx runs `copilotOpen` and hands focus back with a flash when no copilot is configured.
	const focusCopilot = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => ({
		state: { ...state, focus: "copilot" },
		effect: { type: "copilotOpen" },
	});

	// `o` while the indicator shows (any non-idle turn): the event view on the copilot card, from
	// wherever the human is, back to the same place on `esc`.
	const openCopilotEvents = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => ({
		state: {
			...state,
			view: {
				type: "events",
				cardId: CopilotLog.CARD_ID,
				fromView: state.view.type === "detail" ? "detail" : "board",
				fromTaskId:
					state.view.type === "detail" ? state.view.taskId : undefined,
			},
		},
		effect: NONE,
	});

	// The shortcut a `/name` prefix picks: the first whose name starts with what was typed.
	export const matchingShortcuts = (
		shortcuts: readonly CopilotShortcut[],
		text: string,
	): CopilotShortcut[] =>
		text.startsWith("/")
			? shortcuts.filter((s) => `/${s.name}`.startsWith(text))
			: [];

	// The copilot pane while focused. The TEXTAREA owns the buffer and every editing key — printable
	// characters, backspace, word motions, paste, undo — so this reducer never touches the text
	// except to push a whole new value at it (a shortcut expansion, a recalled prompt, a clear after
	// send), which it does through the `copilotSetText` effect.
	//
	// These are the keys it takes away from the textarea, and `copilotConsumes` below is the list
	// app.tsx preventDefaults on so the textarea does not act on them too:
	//   esc       leave, stopping a running turn on the way out (tab is the exit that does not)
	//   tab       complete a `/` being typed, else hand the ring its turn, the way a shell splits it
	//   up/down   walk this session's sent prompts while the buffer is empty
	// `enter` is the textarea's own `submit` binding and arrives through submitCopilot, not here.
	export const copilotConsumes = (
		state: BoardState,
		key: KeyInput,
	): boolean => {
		if (state.focus !== "copilot") return false;
		if (key.name === "escape" || key.name === "tab") return true;
		// A blocked harness takes the digits too: the draft in the buffer cannot be sent while a
		// turn runs anyway, so a `1` typed here is an answer, not a character.
		if (state.copilot.permission && optionIndex(key) !== null) return true;
		return (
			(key.name === "up" || key.name === "down") &&
			state.copilot.text === "" &&
			state.copilot.history.length > 0
		);
	};

	// Which numbered choice a key names, 1-based, or null for a key that names none.
	const optionIndex = (key: KeyInput): number | null => {
		if (key.ctrl || key.meta) return null;
		const digit = Number.parseInt(key.name, 10);
		return digit >= 1 && digit <= 9 ? digit : null;
	};

	// The keys that answer a blocked harness: a digit picks its option, `esc` declines. Null for
	// everything else, which then routes as it always does — so `x` on the transcript still cancels
	// the turn, the way out when the human means to answer neither.
	const answerPermission = (
		state: BoardState,
		request: CopilotPermission,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		const answered = (
			optionId: string | null,
		): { state: BoardState; effect: Effect } => ({
			state: withCopilot(state, { permission: null }),
			effect: { type: "copilotAnswer", id: request.id, optionId },
		});
		if (key.name === "escape") return answered(null);
		const index = optionIndex(key);
		const option = index === null ? undefined : request.options[index - 1];
		return option ? answered(option.id) : null;
	};

	const setText = (
		state: BoardState,
		text: string,
		over: Partial<CopilotState> = {},
	): { state: BoardState; effect: Effect } => ({
		state: withCopilot(state, { text, ...over }),
		effect: { type: "copilotSetText", text },
	});

	// `up` walks back through what was sent this session, `down` forward and then out to an empty
	// buffer. `historyAt` is an index from the END, so a new prompt arriving does not shift the walk.
	const recall = (
		state: BoardState,
		delta: 1 | -1,
	): { state: BoardState; effect: Effect } => {
		const { history, historyAt } = state.copilot;
		const next = Math.min(
			history.length,
			Math.max(0, (historyAt ?? 0) + delta),
		);
		if (next === 0) return setText(state, "", { historyAt: 0 });
		return setText(state, history[history.length - next] ?? "", {
			historyAt: next,
		});
	};

	const reduceCopilotKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		const { text, turn, shortcuts } = state.copilot;
		switch (key.name) {
			case "escape":
				return {
					state: { ...state, focus: "board" },
					effect: turn === "running" ? { type: "copilotCancel" } : NONE,
				};
			case "tab": {
				const first = matchingShortcuts(shortcuts, text)[0];
				return first
					? setText(state, first.template)
					: { state: cycleFocus(state, key.shift ? -1 : 1), effect: NONE };
			}
			case "up":
				return recall(state, 1);
			case "down":
				return recall(state, -1);
			default:
				return { state, effect: NONE };
		}
	};

	// The textarea's `submit` binding, routed through the reducer so the `/name` expansion and the
	// send are one decision. `text` is read off the textarea, which is what the human actually sees.
	export const submitCopilot = (
		state: BoardState,
		text: string,
	): { state: BoardState; effect: Effect } => {
		// One turn at a time; the pane says so rather than queueing behind the human's back.
		if (state.copilot.turn === "running") return { state, effect: NONE };
		const exact = matchingShortcuts(state.copilot.shortcuts, text).find(
			(s) => `/${s.name}` === text,
		);
		// Expanding puts the template in front of the human to read and edit before it is sent.
		if (exact) return setText(state, exact.template);
		if (text.trim() === "") return { state, effect: NONE };
		return {
			// The board takes the keyboard back: having sent a command, the next thing the human does
			// is watch it — `o` for the transcript, j/k to look elsewhere. `A` returns here.
			state: {
				...withCopilot(state, {
					text: "",
					turn: "running",
					history: [...state.copilot.history, text].slice(-HISTORY_CAP),
					historyAt: 0,
				}),
				focus: "board",
			},
			effect: { type: "copilotPrompt", prompt: text },
		};
	};

	// What app.tsx mirrors into the reducer as the human types, so `/` matching sees what they see.
	export const withCopilotText = (
		state: BoardState,
		text: string,
	): BoardState =>
		state.copilot.text === text ? state : withCopilot(state, { text });

	// The reverse entry for a state change: restore the task's pre-mutation state. Shared by the
	// GTD shift (`[`/`]`), the direct jumps (`n`/`s`/`x`), and `d` — all reverse to `{ state }`.
	const stateUndoEntry = (task: Task): UndoEntry => {
		const sid = shortId(task);
		return {
			id: task.id,
			shortId: sid,
			patch: { state: task.state },
			label: `${sid} → ${task.state}`,
		};
	};

	// Lines the detail view scrolls per j/k/arrow press.
	const SCROLL_STEP = 2;

	const clamp = (value: number, min: number, max: number): number =>
		Math.max(min, Math.min(max, value));

	const nextKind = (kind: KindFilter): KindFilter => {
		const i = KIND_CYCLE.indexOf(kind);
		return KIND_CYCLE[(i + 1) % KIND_CYCLE.length] ?? "all";
	};

	const nextStatus = (status: StatusFilter): StatusFilter => {
		const i = STATUS_CYCLE.indexOf(status);
		return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length] ?? "open";
	};

	// The active filter query, lowercased for matching. Empty means "no filter" — both when search is
	// off AND while typing with nothing entered yet (the full list stays visible until the first char).
	export const activeQuery = (search: SearchState): string =>
		search.mode === "off" ? "" : search.query.toLowerCase();

	// Case-insensitive substring match over shortId + title — the two things David scans for.
	const matchesQuery = (task: Task, query: string): boolean =>
		task.title.toLowerCase().includes(query) ||
		shortId(task).toLowerCase().includes(query);

	// The section half of the status filter, on the lifecycle axis: `open` is the unresolved sections
	// (someday included — parked is not finished), `done` is the closed archive alone, and `review`
	// spans everything because a flagged task is as likely to be cancelled or done as in flight.
	// The one exception is the search reach-through: a `/` query from `open` still reaches the
	// archive, so "did X land?" needs no filter change.
	const sectionInStatus = (
		sectionState: BoardData.SectionState,
		status: StatusFilter,
		query: string,
	): boolean =>
		BoardData.isClosed(sectionState)
			? status !== "open" || query !== ""
			: status !== "done";

	// The row half. Only `review` narrows rows — by the flag, wherever it sits, parents and subtasks
	// alike; `open`/`done` are settled a section at a time above.
	const taskInStatus = (task: Task, status: StatusFilter): boolean =>
		status !== "review" || task.needsReview;

	// A section paired with its filtered, flattened rows — what board.tsx renders section-by-section.
	// Concatenating the groups' rows in order IS visibleRows, so the renderer's running row index stays
	// in lockstep with the reducer's mouse addressing by construction.
	export type SectionRows = {
		section: BoardData.BoardSection;
		rows: VisibleRow[];
	};

	// Flatten sections into ordered on-screen rows, expanding only the parents in `expanded`. This is
	// the single source of truth for j/k order, mouse row addressing, and scroll-into-view; board.tsx
	// renders straight from it. BOTH filters — `/` search and the `f` status — are applied HERE (not in
	// a separate pass) so selection, mouse, and scroll all agree: with one active, a matching subtask
	// keeps its parent visible and forces it open (only matching siblings show, so the match is on
	// screen); a matching parent renders normally — its non-matching children stay hidden unless it
	// is in `expanded`.
	// Sections left with no rows by the filter are dropped entirely.
	export const visibleSections = (
		sections: BoardData.BoardSection[],
		expanded: ReadonlySet<string>,
		search: SearchState,
		status: StatusFilter = "open",
	): SectionRows[] => {
		const query = activeQuery(search);
		// Both filters fold into ONE row predicate so the two compose: `/` narrows within the active
		// status rather than replacing it.
		const matches = (task: Task): boolean =>
			taskInStatus(task, status) && (query === "" || matchesQuery(task, query));
		// Whether anything is narrowing the list — `review` filters rows just as a query does, so it
		// takes the same tree-filter branch below (keep a flagged child's parent visible, forced open).
		const narrowing = query !== "" || status === "review";
		const groups: SectionRows[] = [];
		for (const section of sections) {
			if (!sectionInStatus(section.state, status, query)) continue;
			const rows: VisibleRow[] = [];
			const pushChild = (child: Task, parentId: string): void => {
				rows.push({
					task: child,
					depth: 1,
					parentId,
					hasChildren: false,
					expanded: false,
				});
			};
			for (const { task, children } of section.rows) {
				const hasChildren = children.length > 0;
				if (!narrowing) {
					const isExpanded = hasChildren && expanded.has(task.id);
					rows.push({
						task,
						depth: 0,
						parentId: null,
						hasChildren,
						expanded: isExpanded,
					});
					if (isExpanded)
						for (const child of children) pushChild(child, task.id);
					continue;
				}
				const parentMatch = matches(task);
				const visibleChildren =
					parentMatch && expanded.has(task.id)
						? children
						: children.filter(matches);
				if (!parentMatch && visibleChildren.length === 0) continue;
				rows.push({
					task,
					depth: 0,
					parentId: null,
					hasChildren,
					expanded: visibleChildren.length > 0,
				});
				for (const child of visibleChildren) pushChild(child, task.id);
			}
			if (rows.length > 0) groups.push({ section, rows });
		}
		return groups;
	};

	export const visibleRows = (state: BoardState): VisibleRow[] =>
		visibleSections(
			state.sections,
			state.expanded,
			state.search,
			state.status,
		).flatMap((group) => group.rows);

	const rowOf = (
		rows: VisibleRow[],
		id: string | null,
	): VisibleRow | undefined => rows.find((r) => r.task.id === id);

	const firstId = (rows: VisibleRow[]): string | null =>
		rows[0]?.task.id ?? null;

	const shortId = (task: Task): string => task.shortId ?? task.id.slice(0, 8);

	// Find a task anywhere in the board (top-level or subtask) by id — the detail view's action target,
	// which may be a subtask and isn't addressable by the board's selection.
	const taskById = (state: BoardState, id: string): Task | undefined => {
		for (const section of state.sections) {
			for (const { task, children } of section.rows) {
				if (task.id === id) return task;
				for (const child of children) if (child.id === id) return child;
			}
		}
		return undefined;
	};

	// After any change that can hide the selected row (a collapse, a reload that dropped the task),
	// re-anchor selection: keep it if still visible, else fall back to the first row.
	const withSelection = (
		state: BoardState,
		selectedId: string | null,
	): BoardState => {
		const rows = visibleRows(state);
		if (selectedId && rowOf(rows, selectedId)) {
			return { ...state, selectedId };
		}
		return { ...state, selectedId: firstId(rows) };
	};

	// When the selected task vanishes from a reload (under `open`, closing it drops it out of the
	// unresolved sections; or `d` drops it past the archive cap), re-anchor to the NEAREST surviving
	// row by its old position — walking down first, then up — rather than snapping to the top of the
	// list. Falls back to the first row.
	const nearestSurvivor = (
		oldRows: VisibleRow[],
		newRows: VisibleRow[],
		oldIndex: number,
	): string | null => {
		if (oldIndex < 0) return firstId(newRows);
		const alive = new Set(newRows.map((r) => r.task.id));
		for (let d = 1; d < oldRows.length; d++) {
			const below = oldRows[oldIndex + d];
			if (below && alive.has(below.task.id)) return below.task.id;
			const above = oldRows[oldIndex - d];
			if (above && alive.has(above.task.id)) return above.task.id;
		}
		return firstId(newRows);
	};

	// Move selection `delta` rows over the flattened visible list, clamped. With nothing selected, a
	// downward move lands on the first row.
	const move = (
		state: BoardState,
		delta: number,
	): { state: BoardState; effect: Effect } => {
		const rows = visibleRows(state);
		if (rows.length === 0) return { state, effect: NONE };
		const current = rows.findIndex((r) => r.task.id === state.selectedId);
		const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
		const to = clamp(from + delta, 0, rows.length - 1);
		return {
			state: { ...state, selectedId: rows[to]?.task.id ?? null },
			effect: NONE,
		};
	};

	const setExpanded = (
		state: BoardState,
		id: string,
		expanded: boolean,
	): ReadonlySet<string> => {
		const next = new Set(state.expanded);
		if (expanded) next.add(id);
		else next.delete(id);
		return next;
	};

	// `space`/`l`: expand the selected parent (no-op without subtasks or on a child).
	const expandSelected = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const row = rowOf(visibleRows(state), state.selectedId);
		if (row?.depth !== 0 || !row.hasChildren) return { state, effect: NONE };
		if (state.expanded.has(row.task.id)) return { state, effect: NONE };
		return {
			state: { ...state, expanded: setExpanded(state, row.task.id, true) },
			effect: NONE,
		};
	};

	// `h`: on a child, jump selection to its parent (lazygit idiom); on an expanded parent, collapse it;
	// otherwise a no-op.
	const collapseSelected = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const row = rowOf(visibleRows(state), state.selectedId);
		if (!row) return { state, effect: NONE };
		if (row.depth === 1 && row.parentId) {
			return { state: { ...state, selectedId: row.parentId }, effect: NONE };
		}
		if (row.hasChildren && state.expanded.has(row.task.id)) {
			return {
				state: { ...state, expanded: setExpanded(state, row.task.id, false) },
				effect: NONE,
			};
		}
		return { state, effect: NONE };
	};

	// `space` toggles the selected parent open/closed. Collapsing keeps the parent selected (its own row
	// stays visible), so no re-anchor is needed here.
	const toggleSelected = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const row = rowOf(visibleRows(state), state.selectedId);
		if (row?.depth !== 0 || !row.hasChildren) return { state, effect: NONE };
		return {
			state: {
				...state,
				expanded: setExpanded(
					state,
					row.task.id,
					!state.expanded.has(row.task.id),
				),
			},
			effect: NONE,
		};
	};

	// Move the selected task to the state `delta` steps away in the GTD progression (−1 for `[`, +1 for
	// `]`). Progression order is independent of the section display order.
	const shiftState = (
		state: BoardState,
		delta: number,
	): { state: BoardState; effect: Effect } => {
		const row = rowOf(visibleRows(state), state.selectedId);
		if (!row) return { state, effect: NONE };
		const progression: readonly TaskState[] = BoardData.STATE_PROGRESSION;
		const current = progression.indexOf(row.task.state);
		const target = BoardData.STATE_PROGRESSION[current + delta];
		if (current < 0 || !target) return { state, effect: NONE };
		return {
			state: withUndo(state, stateUndoEntry(row.task)),
			effect: {
				type: "setState",
				id: row.task.id,
				state: target,
				notice: `${shortId(row.task)} → ${target}`,
			},
		};
	};

	// Direct state jump (`n` → next, `s` → someday, `x` → cancelled) on the action target — any current
	// state, no progression walk. `someday` now lands in its own visible section; `cancelled` closes the
	// task and so leaves the `open` view, and selection re-anchors on the following reload (see
	// nearestSurvivor). `verb` shapes the flash: an arrow for a move that keeps it in play, a
	// past-tense word for cancel.
	const jumpState = (
		state: BoardState,
		task: Task | undefined,
		target: TaskState,
		verb: string,
	): { state: BoardState; effect: Effect } => {
		if (!task) return { state, effect: NONE };
		return {
			state: withUndo(state, stateUndoEntry(task)),
			effect: {
				type: "setState",
				id: task.id,
				state: target,
				notice: `${shortId(task)} ${verb}`,
			},
		};
	};

	// `v`: run the planner review op on the action target. A no-op (with a flash, never silent) when the
	// task carries no review flag — there is nothing to clear.
	const reviewTask = (
		state: BoardState,
		task: Task | undefined,
	): { state: BoardState; effect: Effect } => {
		if (!task) return { state, effect: NONE };
		if (!task.needsReview) {
			return {
				state,
				effect: {
					type: "notice",
					notice: { text: `${shortId(task)}: no review flag`, tone: "success" },
				},
			};
		}
		const sid = shortId(task);
		const priorVerification = task.verification;
		const entry: UndoEntry = {
			id: task.id,
			shortId: sid,
			patch: {
				needsReview: true,
				...(priorVerification ? { verification: priorVerification } : {}),
			},
			label: `${sid} review restored`,
		};
		return {
			state: withUndo(state, entry),
			effect: {
				type: "markReviewed",
				id: task.id,
				notice: `${sid} reviewed`,
			},
		};
	};

	export const init = (
		sections: BoardData.BoardSection[],
		opts: { scoped: boolean; kind?: KindFilter; status?: StatusFilter },
	): BoardState => {
		const base: BoardState = {
			sections,
			selectedId: null,
			expanded: new Set<string>(),
			kind: opts.kind ?? "all",
			status: opts.status ?? "open",
			scoped: opts.scoped,
			view: { type: "board" },
			search: SEARCH_OFF,
			dispatch: null,
			help: false,
			focus: "board",
			sidebar: { visible: true, selected: 0, itemCount: 0 },
			marked: new Set<string>(),
			copilot: COPILOT_IDLE,
			undo: [],
		};
		return { ...base, selectedId: firstId(visibleRows(base)) };
	};

	// Merge freshly loaded sections into an existing state, keeping the same task selected and the same
	// parents expanded across the reload. If the selected task vanished (a state move out of the visible
	// sections, or a drop past the done cap), re-anchor to the nearest surviving row by its old position
	// rather than the top. Stale expanded ids are harmless (visibleRows ignores parents that no longer
	// exist).
	export const withSections = (
		state: BoardState,
		sections: BoardData.BoardSection[],
	): BoardState => {
		const next = { ...state, sections };
		const oldRows = visibleRows(state);
		const newRows = visibleRows(next);
		if (state.selectedId && rowOf(newRows, state.selectedId)) {
			return next;
		}
		const oldIndex = oldRows.findIndex((r) => r.task.id === state.selectedId);
		return { ...next, selectedId: nearestSurvivor(oldRows, newRows, oldIndex) };
	};

	// FTS tier-2 merge: splice tasks from Planner.searchTasks into their state's section as extra
	// flat rows (no subtask fetch — FTS results are a ranked list, not a tree). Dedupes by id against
	// already-loaded rows. Stale-query guard: if the board's active query has moved on since the FTS
	// call fired, the merge no-ops (the classic async-race; pure fn so the test is trivial). Sections
	// that don't exist yet (e.g. done wasn't loaded because no done rows existed in tier 1) are
	// created. Selection is re-anchored after merge.
	export const withSearchResults = (
		state: BoardState,
		answeredQuery: string,
		tasks: Task[],
	): BoardState => {
		// Stale guard: the board has moved on; drop the response.
		if (activeQuery(state.search) !== answeredQuery.toLowerCase()) return state;
		if (tasks.length === 0) return state;

		const existingIds = new Set<string>();
		for (const section of state.sections) {
			for (const row of section.rows) {
				existingIds.add(row.task.id);
				for (const child of row.children) existingIds.add(child.id);
			}
		}

		// Group new tasks by state for section placement.
		const newByState = new Map<TaskState, Task[]>();
		for (const task of tasks) {
			if (existingIds.has(task.id)) continue;
			const list = newByState.get(task.state) ?? [];
			list.push(task);
			newByState.set(task.state, list);
		}
		if (newByState.size === 0) return state;

		// Merge into existing sections or create new ones. Preserve display order from SECTION_STATES.
		const sectionMap = new Map<
			BoardData.SectionState,
			BoardData.BoardSection
		>();
		for (const section of state.sections) {
			sectionMap.set(section.state, section);
		}

		const merged: BoardData.BoardSection[] = [];
		for (const sectionState of BoardData.SECTION_STATES) {
			const existing = sectionMap.get(sectionState);
			const additions = newByState.get(sectionState);
			if (!existing && !additions) continue;
			const rows = existing ? [...existing.rows] : [];
			if (additions) {
				for (const task of additions) {
					rows.push({ task, children: [] });
				}
			}
			merged.push({
				state: sectionState,
				label: existing?.label ?? TASK_STATE_DISPLAY[sectionState].label,
				rows,
			});
		}
		// No fallback pass for states outside SECTION_STATES: it now lists all seven, so the loop
		// above reaches every key `newByState` can hold. The pass that used to sit here fabricated a
		// section with an unchecked cast and labelled it with the raw state string — which is what a
		// someday or cancelled FTS hit used to render as.

		return withSelection({ ...state, sections: merged }, state.selectedId);
	};

	// The single key router: pure (state, key) -> (state, effect). Modals route FIRST (help, then
	// dispatch — each owns the keyboard while open), then by the current view — the detail view
	// swallows `esc`/`q` to pop back to the board, so neither falls through to the board's
	// scope-widen / quit. Unknown keys return the same state reference so the caller can skip a
	// re-render.
	export const reduceKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.help) return reduceHelpKey(state, key);
		if (state.dispatch) return reduceDispatchKey(state, state.dispatch, key);
		// A harness blocked on a question is the most urgent thing on screen, so it takes the keys
		// that answer it — a digit, `esc` — ahead of every view and of the copilot's own focus. That
		// is the esc layering the board already has, one press one level: the newest, most local
		// thing goes first, and here it is the thing something else is waiting on. Search-typing is
		// the exception, where a digit is a query character. Every other key falls through.
		if (state.copilot.permission && state.search.mode !== "typing") {
			const answered = answerPermission(state, state.copilot.permission, key);
			if (answered) return answered;
		}
		// The copilot owns the keyboard while focused, and decides for itself what `tab` means there.
		if (state.focus === "copilot") return reduceCopilotKey(state, key);
		// A finished turn's footer indicator stays up until the next keypress — except `o`, which is
		// the key that opens it, and the search box, where a keypress is a query character.
		if (
			(state.copilot.turn === "done" || state.copilot.turn === "error") &&
			key.name !== "o" &&
			state.search.mode !== "typing"
		)
			return reduceKey(withCopilotTurn(state, "idle"), key);
		// ctrl-z routes across every view (board + detail), after the modals own the keyboard and before
		// view routing. Inert while a `/` query is being typed (ctrl isn't a printable query char anyway).
		if (isUndoKey(key) && state.search.mode !== "typing")
			return reduceUndo(state);
		// Focus-level keys, once for every view: which pane has the keyboard is not a property of
		// what is on screen. All four are query characters while a `/` search is being typed, so the
		// whole group defers to that branch inside reduceBoardKey.
		if (state.search.mode !== "typing") {
			if (isHelpKey(key))
				return { state: { ...state, help: true }, effect: NONE };
			if (isCopilotKey(key)) return focusCopilot(state);
			if (key.name === "tab")
				return {
					state: cycleFocus(state, key.shift ? -1 : 1),
					effect: NONE,
				};
			if (key.name === "b")
				return { state: toggleSidebar(state), effect: NONE };
		}
		if (state.focus === "sidebar" && state.sidebar.visible)
			return reduceSidebarKey(state, key);
		if (state.view.type === "events") return reduceEventsKey(state, key);
		return state.view.type === "detail"
			? reduceDetailKey(state, key)
			: reduceBoardKey(state, key);
	};

	// ctrl-z: pop the most recent entry and emit its reverse patch as an applyUndo effect. Empty stack
	// flashes "nothing to undo" (never silent — footer philosophy). No redo — undo never pushes an entry.
	const reduceUndo = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const top = state.undo[state.undo.length - 1];
		if (!top) {
			return {
				state,
				effect: {
					type: "notice",
					notice: { text: "nothing to undo", tone: "success" },
				},
			};
		}
		return {
			state: { ...state, undo: state.undo.slice(0, -1) },
			effect: {
				type: "applyUndo",
				id: top.id,
				patch: top.patch,
				notice: `undo: ${top.label}`,
			},
		};
	};

	// Event view: j/k scroll, esc/q pop back to the previous view. `b` and `tab` control sidebar
	// visibility and focus (same as board/detail views).
	const reduceEventsKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.view.type !== "events") return { state, effect: NONE };
		switch (key.name) {
			case "escape":
			case "q": {
				const back =
					state.view.fromView === "detail" && state.view.fromTaskId
						? { type: "detail" as const, taskId: state.view.fromTaskId }
						: { type: "board" as const };
				return { state: { ...state, view: back }, effect: NONE };
			}
			case "j":
			case "down":
				return { state, effect: { type: "scroll", delta: 2 } };
			case "k":
			case "up":
				return { state, effect: { type: "scroll", delta: -2 } };
			case "x":
				// On the copilot's transcript, `x` stops the turn (host cards are read-only here).
				return state.view.cardId === CopilotLog.CARD_ID &&
					state.copilot.turn === "running"
					? { state, effect: { type: "copilotCancel" } }
					: { state, effect: NONE };
			default:
				return { state, effect: NONE };
		}
	};

	// Help overlay: `?`, esc, or q closes; everything else is inert (modal, same as dispatch).
	const reduceHelpKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (isHelpKey(key) || key.name === "escape" || key.name === "q") {
			return { state: { ...state, help: false }, effect: NONE };
		}
		return { state, effect: NONE };
	};

	// Dispatch overlay: one list of host triggers. While loading only esc works; then j/k and 1-9
	// select, enter fires a satisfiable trigger (an unsatisfiable one flashes its hint), esc closes.
	const reduceDispatchKey = (
		state: BoardState,
		overlay: DispatchOverlay,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (key.name === "escape")
			return { state: { ...state, dispatch: null }, effect: NONE };
		if (overlay.loading) return { state, effect: NONE };
		const last = Math.max(0, overlay.triggers.length - 1);
		const select = (
			selected: number,
		): { state: BoardState; effect: Effect } => ({
			state: { ...state, dispatch: { ...overlay, selected } },
			effect: NONE,
		});
		switch (key.name) {
			case "j":
			case "down":
				return select(clamp(overlay.selected + 1, 0, last));
			case "k":
			case "up":
				return select(clamp(overlay.selected - 1, 0, last));
			case "return":
			case "enter": {
				const trigger = overlay.triggers[overlay.selected];
				if (!trigger) return { state, effect: NONE };
				if (!trigger.satisfiable) {
					return {
						state,
						effect: {
							type: "notice",
							notice: {
								text: trigger.hint ?? `${trigger.label} needs inputs`,
								tone: "error",
							},
						},
					};
				}
				return {
					state: { ...state, dispatch: null },
					effect: {
						type: "dispatch",
						triggerId: trigger.id,
						id: overlay.taskId,
					},
				};
			}
			default: {
				const digit = Number.parseInt(key.name, 10);
				if (digit >= 1 && digit <= overlay.triggers.length)
					return select(digit - 1);
				return { state, effect: NONE };
			}
		}
	};

	// Opens the overlay for `taskId` in its loading state; app.tsx runs the `loadTriggers` effect and
	// merges the answer back with `withTriggers`.
	const openDispatch = (
		state: BoardState,
		taskId: string,
	): { state: BoardState; effect: Effect } => ({
		state: {
			...state,
			dispatch: { taskId, triggers: [], selected: 0, loading: true },
		},
		effect: { type: "loadTriggers", taskId },
	});

	// Called by app.tsx after the host lists its triggers. No-op if the overlay closed meanwhile.
	export const withTriggers = (
		state: BoardState,
		triggers: TriggerDescriptor[],
	): BoardState => {
		if (!state.dispatch) return state;
		return {
			...state,
			dispatch: { ...state.dispatch, triggers, loading: false, selected: 0 },
		};
	};

	// Mouse router, parallel to reduceKey. Board-only actions (`select`, `toggleExpand`) no-op while the
	// detail view is open (those handlers unmount with the board); `copy` is valid in both views. All
	// mouse input is inert while a true modal (dispatch, help) is open, same as keys. The copilot is
	// not one: a click lands on the board, so it brings focus along with it.
	export const reduceMouse = (
		incoming: BoardState,
		action: MouseAction,
	): { state: BoardState; effect: Effect } => {
		if (incoming.help || incoming.dispatch)
			return { state: incoming, effect: NONE };
		// A click is the human saying they are working on the board now.
		const state: BoardState =
			incoming.focus === "board" ? incoming : { ...incoming, focus: "board" };
		if (action.type === "copy") {
			const id =
				state.view.type === "detail" ? state.view.taskId : state.selectedId;
			return id
				? { state, effect: { type: "copy", id } }
				: { state, effect: NONE };
		}
		if (state.view.type !== "board") return { state, effect: NONE };
		const rows = visibleRows(state);
		const row = rows[action.row];
		if (!row) return { state, effect: NONE };
		switch (action.type) {
			case "select": {
				// Click the already-selected row = open it (click-click, no double-click detection);
				// clicking any other row just selects it.
				return row.task.id === state.selectedId
					? {
							state: {
								...state,
								view: { type: "detail", taskId: row.task.id },
							},
							effect: NONE,
						}
					: { state: { ...state, selectedId: row.task.id }, effect: NONE };
			}
			case "toggleExpand": {
				// Caret click: toggle a parent. Collapsing can hide the selected child — re-anchor to the
				// parent in that case so selection lands somewhere sensible, not the top of the list.
				if (row.depth !== 0 || !row.hasChildren) return { state, effect: NONE };
				const willExpand = !state.expanded.has(row.task.id);
				const expanded = setExpanded(state, row.task.id, willExpand);
				const selected = rows.find((r) => r.task.id === state.selectedId);
				const selectedId =
					!willExpand && selected?.parentId === row.task.id
						? row.task.id
						: state.selectedId;
				return {
					state: withSelection({ ...state, expanded, selectedId }, selectedId),
					effect: NONE,
				};
			}
		}
	};

	// Detail view: `esc`/`q` pop back to the board (never widen scope or quit); j/k/arrows scroll the
	// brief; `y` copies the open task's brief; the status keys (`v`/`x`/`n`/`s`) act on the OPEN task (not
	// the board's selection) and the brief refreshes after the mutation; everything else is a no-op.
	const reduceDetailKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.view.type !== "detail") return { state, effect: NONE };
		const target = taskById(state, state.view.taskId);
		switch (key.name) {
			case "escape":
			case "q":
				return { state: { ...state, view: { type: "board" } }, effect: NONE };
			case "j":
			case "down":
				return { state, effect: { type: "scroll", delta: SCROLL_STEP } };
			case "k":
			case "up":
				return { state, effect: { type: "scroll", delta: -SCROLL_STEP } };
			case "y":
				return { state, effect: { type: "copy", id: state.view.taskId } };
			case "m":
				return toggleMark(state, state.view.taskId);
			case "o":
				// The copilot's transcript wins while its indicator is up; otherwise the task's events.
				return state.copilot.turn === "idle"
					? {
							state,
							effect: { type: "openEvents", taskId: state.view.taskId },
						}
					: openCopilotEvents(state);
			case "a":
				return openDispatch(state, state.view.taskId);
			case "v":
				return reviewTask(state, target);
			case "x":
				return jumpState(state, target, "cancelled", "cancelled");
			case "n":
				return jumpState(state, target, "next", "→ next");
			case "s":
				return jumpState(state, target, "someday", "→ someday");
			default:
				return { state, effect: NONE };
		}
	};

	// Swap the search state and re-anchor selection over the newly filtered rows: keep the current
	// selection if it's still visible, else the first match (same pattern as withSelection everywhere).
	const withSearch = (
		state: BoardState,
		search: SearchState,
	): { state: BoardState; effect: Effect } => ({
		state: withSelection({ ...state, search }, state.selectedId),
		effect: NONE,
	});

	// Same shape as withSearch: a view-level filter change re-anchors selection itself, because unlike
	// the kind filter there is no reload (and so no withSections pass) to do it. Without this, `f` can
	// leave selectedId on a row that is no longer rendered and j/k jump from nowhere.
	const withStatus = (
		state: BoardState,
		status: StatusFilter,
	): { state: BoardState; effect: Effect } => ({
		state: withSelection({ ...state, status }, state.selectedId),
		effect: NONE,
	});

	// A single printable character for the query: OpenTUI's ParsedKey carries the raw `sequence`; one
	// char, no ctrl/meta, and above the C0 control range (also excludes DEL 0x7f). Space and every
	// shifted symbol pass through; escape/return/backspace are handled by name before this runs.
	const printableChar = (key: KeyInput): string | null => {
		if (key.ctrl || key.meta) return null;
		const seq = key.sequence;
		if (seq?.length !== 1) return null;
		const code = seq.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f ? seq : null;
	};

	// Search-input mode: the query owns the keyboard. Escape cancels AND clears; enter commits (empty
	// query = clear, same as escape); backspace deletes; printable chars append. EVERYTHING else is
	// inert — `q`, `j`, `d` are query characters here, not bindings.
	const reduceSearchTyping = (
		state: BoardState,
		query: string,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		switch (key.name) {
			case "escape":
				return withSearch(state, SEARCH_OFF);
			case "return":
			case "enter":
				return query === ""
					? withSearch(state, SEARCH_OFF)
					: withSearch(state, { mode: "committed", query });
			case "backspace":
				return withSearch(state, {
					mode: "typing",
					query: query.slice(0, -1),
				});
			default: {
				const char = printableChar(key);
				return char
					? withSearch(state, { mode: "typing", query: query + char })
					: { state, effect: NONE };
			}
		}
	};

	// Sidebar key routing: j/k navigate the flat sidebar item list, enter opens the item,
	// esc returns focus to the board, tab toggles focus.
	const reduceSidebarKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		const last = Math.max(0, state.sidebar.itemCount - 1);
		switch (key.name) {
			case "escape":
				return { state: { ...state, focus: "board" }, effect: NONE };
			case "j":
			case "down":
				return {
					state: {
						...state,
						sidebar: {
							...state.sidebar,
							selected: clamp(state.sidebar.selected + 1, 0, last),
						},
					},
					effect: NONE,
				};
			case "k":
			case "up":
				return {
					state: {
						...state,
						sidebar: {
							...state.sidebar,
							selected: clamp(state.sidebar.selected - 1, 0, last),
						},
					},
					effect: NONE,
				};
			case "return":
			case "enter":
				// The actual item resolution happens in app.tsx — we emit a sidebarSelect effect.
				return {
					state,
					effect: { type: "sidebarSelect" },
				};
			default:
				return { state, effect: NONE };
		}
	};

	const reduceBoardKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.search.mode === "typing")
			return reduceSearchTyping(state, state.search.query, key);
		// After the typing branch (there `?` is a query character), before the name switch (shifted
		// keys have parser-dependent names — isHelpKey matches the sequence too).
		switch (key.name) {
			case "q":
				return { state, effect: { type: "quit" } };
			case "r":
				return { state, effect: { type: "reload" } };
			case "k":
			case "up":
				return move(state, -1);
			case "j":
			case "down":
				return move(state, 1);
			case "space":
				return toggleSelected(state);
			case "l":
			case "right":
				return expandSelected(state);
			case "h":
			case "left":
				return collapseSelected(state);
			case "return":
			case "enter": {
				const row = rowOf(visibleRows(state), state.selectedId);
				return row
					? {
							state: {
								...state,
								view: { type: "detail", taskId: row.task.id },
							},
							effect: NONE,
						}
					: { state, effect: NONE };
			}
			case "i":
				return {
					state: { ...state, kind: nextKind(state.kind) },
					effect: { type: "reload" },
				};
			// No reload, unlike `i`: every state is already loaded each poll (done capped to its recent
			// window) and every row already carries needsReview, so `f` filters rows in hand.
			case "f":
				return withStatus(state, nextStatus(state.status));
			case "/":
				// Enter search-input mode with a fresh query (vim idiom — `/` always starts over).
				return {
					state: { ...state, search: { mode: "typing", query: "" } },
					effect: NONE,
				};
			case "escape":
				// Esc layering, one esc one level: marks clear first (the most recent, most local thing
				// the human added), then a committed filter, then scope widens. Marks therefore never
				// survive into a widened list they were not picked from. (Typing-mode esc never reaches
				// here; reduceSearchTyping owns it.)
				if (state.marked.size > 0)
					return { state: { ...state, marked: NO_MARKS }, effect: NONE };
				if (state.search.mode === "committed")
					return withSearch(state, SEARCH_OFF);
				return state.scoped
					? { state: { ...state, scoped: false }, effect: { type: "reload" } }
					: { state, effect: NONE };
			case "m":
				return toggleMark(
					state,
					rowOf(visibleRows(state), state.selectedId)?.task.id,
				);
			case "o":
				// The board has no per-task events; `o` here is the copilot's transcript, when there is one.
				return state.copilot.turn === "idle"
					? { state, effect: NONE }
					: openCopilotEvents(state);
			case "[":
				return shiftState(state, -1);
			case "]":
				return shiftState(state, 1);
			case "d": {
				const row = rowOf(visibleRows(state), state.selectedId);
				if (!row) return { state, effect: NONE };
				return {
					state: withUndo(state, stateUndoEntry(row.task)),
					effect: {
						type: "markDone",
						id: row.task.id,
						notice: `${shortId(row.task)} done`,
					},
				};
			}
			case "v":
				return reviewTask(
					state,
					rowOf(visibleRows(state), state.selectedId)?.task,
				);
			case "x":
				return jumpState(
					state,
					rowOf(visibleRows(state), state.selectedId)?.task,
					"cancelled",
					"cancelled",
				);
			case "n":
				return jumpState(
					state,
					rowOf(visibleRows(state), state.selectedId)?.task,
					"next",
					"→ next",
				);
			case "s":
				return jumpState(
					state,
					rowOf(visibleRows(state), state.selectedId)?.task,
					"someday",
					"→ someday",
				);
			case "y": {
				// Fast dispatch path: copy the selected row's brief WITHOUT opening detail.
				const row = rowOf(visibleRows(state), state.selectedId);
				return row
					? { state, effect: { type: "copy", id: row.task.id } }
					: { state, effect: NONE };
			}
			case "a": {
				// Open the dispatch overlay on the selected row (no-op with nothing selected).
				const row = rowOf(visibleRows(state), state.selectedId);
				return row ? openDispatch(state, row.task.id) : { state, effect: NONE };
			}
			default:
				return { state, effect: NONE };
		}
	};
}
