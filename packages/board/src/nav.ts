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
import { CardTab } from "./card-tab";
import { BoardChecklist } from "./checklist";
import { CopilotLog } from "./copilot-log";
import { BoardData } from "./data";
import { BoardDecisions } from "./decisions";
import { DetailModel } from "./detail-model";
import { ElicitationForm } from "./elicitation-form";
import type { Keymap } from "./keymap";
import type {
	CopilotElicitation,
	CopilotElicitationAnswer,
	CopilotCommand,
	CopilotPermission,
	CopilotShortcut,
	CopilotUpdate,
	TriggerDescriptor,
} from "./ports";
import { BoardPrompt } from "./prompt";
import { PromptHistory } from "./prompt-history";
import { BoardTabs } from "./tabs";
import { TriggerForm } from "./trigger-form";

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
	// one level — from detail back to the board — WITHOUT the same press also widening scope. A detail
	// view without a `tab` is on the default one; the events view remembers the tab it was opened
	// from, so `esc` lands back on it. A detail view may carry a session question pinned over it
	// (`!`, or `o` from a card's tab), answerable with the brief on screen.
	type BoardView =
		| { type: "board" }
		| {
				type: "detail";
				taskId: string;
				tab?: DetailModel.Tab;
				banner?: BoardTabs.Banner;
		  }
		| {
				type: "events";
				cardId: string;
				fromView: "board" | "detail";
				fromTaskId?: string;
				fromTab?: DetailModel.Tab;
				// `t`: every tool row open, the ones still to come too; absent, every row closed. A
				// click still opens or closes one row against it.
				toolDetails?: boolean;
		  };

	/** The tab a detail view is on. */
	export const detailTab = (view: BoardView): DetailModel.Tab =>
		(view.type === "detail" ? view.tab : undefined) ?? DetailModel.DEFAULT_TAB;

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

	// The `a` dispatch overlay: a picker over the host Dispatcher's triggers for one task. Opens in
	// `loading` while the host lists them; while open it owns the keyboard (same modal discipline as
	// search-typing). A trigger the board can fill in opens its form over the picker
	// (trigger-form.ts) before it fires.
	export type DispatchOverlay = {
		taskId: string;
		triggers: TriggerDescriptor[];
		selected: number;
		loading: boolean;
		form?: TriggerForm.Form;
	};

	// Where the copilot's turn is, as far as the keyboard cares: `running` gates a second prompt and
	// enables cancel; `done`/`error` keep the footer indicator up until the next keypress, which is
	// what `idle` means. The transcript itself lives in app.tsx (CopilotLog), not here.
	export type CopilotTurn = "idle" | "running" | "done" | "error";

	// One thing the harness is blocked on: a permission, answered with one key, or a form, filled in
	// a field at a time with the human's draft carried beside it.
	export type CopilotAsk =
		| { type: "permission"; request: CopilotPermission }
		| {
				type: "elicitation";
				request: CopilotElicitation;
				draft: ElicitationForm.Draft;
		  };

	export type CopilotState = {
		// A MIRROR of the textarea's buffer, not the source of truth — app.tsx pushes it here on every
		// content change so `/` matching and the collapsed row's draft hint see what the human sees.
		text: string;
		// Prompts sent this session, oldest first; `up` in an empty buffer walks back through them.
		history: readonly string[];
		// Which `/` shortcut the palette has selected. Only meaningful while something matches, and
		// reset whenever the text changes, because the list under it has changed too.
		paletteAt: number;
		// How far back the walk is, counted from the END so a new prompt does not shift it. 0 = out.
		historyAt: number;
		turn: CopilotTurn;
		// Whether this session has a transcript to open. Mirrored from app.tsx, which owns the log,
		// because `o` has to keep working long after the turn that wrote it stopped showing an
		// indicator — the log outlives the turn by several of them.
		hasLog: boolean;
		// From the host's `Copilot.shortcuts()`, set once by app.tsx; the `/` expansions.
		shortcuts: readonly CopilotShortcut[];
		// The harness's own `/` commands as its last `commands` update listed them, as palette rows.
		// Empty until the session has opened and said.
		commands: readonly PaletteEntry[];
		// The actor uri the copilot's writes are stamped with, likewise set once. Null for a host
		// copilot that names none.
		actor: string | null;
		// The requests the harness is blocked on, permissions and forms alike, oldest first; the head
		// is the one on screen. A queue because a harness running tools in parallel asks for each of
		// them before hearing back on any. Each leaves the moment it is answered, and all of them when
		// the turn stops running — never by a timeout and never by the board picking an option, which
		// is the whole point of carrying them this far.
		asks: readonly CopilotAsk[];
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

	// `O` opens the selected task's linked issue — shifted like `A`, so match the name or the sequence.
	// It pairs with `o` (the event log): lowercase looks inward at this task's own history, uppercase
	// looks outward at the team's tracker.
	const isOpenLinkKey = (key: KeyInput): boolean =>
		!key.ctrl && !key.meta && (key.name === "O" || key.sequence === "O");

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
	export type Focus = "board" | "copilot";

	// Reverse patch — the subset of task fields any board mutation can change. Applied verbatim through
	// Planner.updateTask to walk a task back to its pre-mutation values.
	type UndoPatch = Partial<
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
		// The tab bar and the questions waiting on the human (tabs.ts).
		tabs: BoardTabs.Tabs;
		// The working set: task ids toggled with `m`, in mark order (a Set keeps insertion order, and
		// the copilot's context drops the OLDEST mark first when its brief budget runs out). Survives
		// every reload; `esc` clears it before it clears anything else.
		marked: ReadonlySet<string>;
		// The host's one line over the board's footer (Announcer), until `esc` dismisses it.
		announcement: string | null;
		// The decisions agents filed on issues: counted on the rows, filtered by `u`, asked on the
		// detail view (decisions.ts).
		decisions: BoardDecisions.Decisions;
		// The checklists on issues: progress on the rows, items toggled on the detail view
		// (checklist.ts).
		checklist: BoardChecklist.Checklist;
		copilot: CopilotState;
		// A prompt opened over a card's tab or a question's banner (prompt.ts): the copilot's input,
		// typed for a card's action or a question's answer instead.
		prompt: BoardPrompt.Prompt;
		// Bounded, in-memory (per board session), LIFO stack of reverse patches. Pushed OPTIMISTICALLY at
		// reduce time — mutations to local SQLite essentially never fail, and a failed forward write leaves
		// its reverse patch a harmless no-op (the field is already at the prior value). Preserved across
		// every reload (withSections/withSearchResults spread it through). No redo.
		undo: readonly UndoEntry[];
		// What a digit answered as of the last render and since when (sight): how the keys tell a
		// question the human has had time to read from one that appeared under a key already on its way.
		sighted: Sighting;
	};

	type Sighting = { target: string | undefined; since: number };

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
		// `J/K` on the detail view's checklist: the scrollbox brings the row with this id into view.
		| { type: "reveal"; id: string }
		// j/k on the `?` sheet: its own scrollbox, not the view's under it (app.tsx holds that ref too).
		| { type: "helpScroll"; delta: number }
		| { type: "copy"; id: string }
		| { type: "notice"; notice: Notice }
		// Fire a trigger on a task, with its form's values when it had one.
		| {
				type: "dispatch";
				triggerId: string;
				id: string;
				inputs?: Readonly<Record<string, unknown>>;
		  }
		| { type: "loadTriggers"; taskId: string }
		// A session question answered from its banner: core writes the decision.
		| { type: "answerQuestion"; questionId: string; answer: string }
		// A decision answered on its issue's detail (BoardDecisions): `Questions.answer` writes it.
		| {
				type: "answerDecision";
				questionId: string;
				handle: string;
				answer: string;
				reasoning?: string;
		  }
		// A checklist item ticked or unticked on its issue's detail (BoardChecklist): `Checklist.tick`.
		| { type: "tickItem"; itemId: string; handle: string; done: boolean }
		// `w` closed a finished card's tab: the host forgets the card (ActivitySource.dismiss).
		| { type: "dismiss"; cardId: string }
		// One of a card's actions, with the prompt's text and the lane on screen when it has them.
		| {
				type: "act";
				cardId: string;
				actionId: string;
				text?: string;
				lane?: string;
		  }
		// Push a whole new value into the prompt's textarea (a recalled one).
		| { type: "promptSetText"; text: string }
		| { type: "openEvents"; taskId: string }
		// `O`: hand this task's linked issue to the OS. app.tsx reads the link and composes the notice.
		| { type: "openLink"; id: string }
		// The window just opened; app.tsx closes it with a flash when no copilot is configured.
		| { type: "copilotOpen" }
		| { type: "copilotPrompt"; prompt: string }
		// Push a whole new value into the textarea, which owns the buffer: expand, recall, clear.
		| { type: "copilotSetText"; text: string }
		| { type: "copilotCancel" }
		// The human picked an option for the blocked harness, or declined with `null`.
		| { type: "copilotAnswer"; id: string; optionId: string | null }
		// The human filled in the harness's form, or declined it.
		| {
				type: "copilotAnswerForm";
				id: string;
				answer: CopilotElicitationAnswer;
		  };

	/**
	 * A guard for the effects of `types`, for the part of app.tsx that runs them. Typed from the same
	 * list it checks, so what it admits is exactly what its runner is typed to take.
	 */
	export const effectsOf = <T extends Effect["type"]>(types: readonly T[]) => {
		const owned: ReadonlySet<string> = new Set(types);
		return (effect: Effect): effect is Extract<Effect, { type: T }> =>
			owned.has(effect.type);
	};

	// Mouse actions routed through the SAME pure reducer as keys, so selection stays single-sourced.
	// Rows are addressed by their VISIBLE index (see visibleRows) — the wheel no longer moves selection
	// (the scrollbox scrolls the viewport natively), so there is no scroll action here.
	export type MouseAction =
		| { type: "select"; row: number }
		| { type: "toggleExpand"; row: number }
		| { type: "copy" }
		| { type: "detailTab"; tab: DetailModel.Tab }
		// The tab bar: a card's tab, or the tracker (null).
		| { type: "tab"; id: string | null }
		// The pinned banner's `index`th answer.
		| { type: "answer"; index: number }
		// A lane chip on a card's tab (0 is every lane).
		| { type: "lane"; index: number }
		// A field of the trigger form, by its place in the trigger's inputs.
		| { type: "formField"; index: number }
		// The host's announcement, which a click puts away as `esc` does.
		| { type: "announcement" }
		// A checklist item on the detail view, which a click toggles.
		| { type: "checklistItem"; id: string }
		| AskClick
		| BoardDecisions.Click;

	/**
	 * A click on the copilot's ask: its `index`th answer, the key a hint names (as the key router
	 * reads it: `return`, `space`, `s`, `escape`), or the row that names an ask the keys cannot reach,
	 * which hands it them.
	 */
	export type AskClick =
		| { type: "askOption"; index: number }
		| { type: "askKey"; name: string }
		| { type: "askReach" };

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

	const COPILOT_IDLE: CopilotState = {
		text: "",
		paletteAt: 0,
		history: [],
		historyAt: 0,
		turn: "idle",
		hasLog: false,
		shortcuts: [],
		commands: [],
		actor: null,
		asks: [],
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
		state.copilot.turn === turn && state.copilot.asks.length === 0
			? state
			: withCopilot(state, { turn, asks: [] });

	// Called by app.tsx whenever the log changes; the reducer keeps only the one bit it routes on.
	export const withCopilotLog = (
		state: BoardState,
		hasLog: boolean,
	): BoardState =>
		state.copilot.hasLog === hasLog ? state : withCopilot(state, { hasLog });

	// The harness asked something mid-turn. It joins the back of the queue: the human answers in the
	// order the harness asked, and an earlier question is never pushed off screen by a later one.
	const withAsk = (state: BoardState, ask: CopilotAsk): BoardState =>
		state.copilot.asks.some((queued) => queued.request.id === ask.request.id)
			? state
			: withCopilot(state, { asks: [...state.copilot.asks, ask] });

	export const withCopilotPermission = (
		state: BoardState,
		permission: CopilotPermission,
	): BoardState => withAsk(state, { type: "permission", request: permission });

	// The harness took a request back unanswered: it leaves the queue wherever it was in it, so its
	// block goes and its keys answer nothing. The same state when it is not queued (answered first).
	export const withCopilotWithdrawn = (
		state: BoardState,
		id: string,
	): BoardState =>
		state.copilot.asks.some((queued) => queued.request.id === id)
			? withoutAsk(state, id)
			: state;

	// A form, from its first field with nothing filled in.
	export const withCopilotElicitation = (
		state: BoardState,
		request: CopilotElicitation,
	): BoardState =>
		withAsk(state, {
			type: "elicitation",
			request,
			draft: ElicitationForm.start(),
		});

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

	// The ring, in tab order: the view on screen, then the copilot pane under it.
	const RING: readonly Focus[] = ["board", "copilot"];

	// `delta` is +1 for tab, -1 for ⇧tab.
	const cycleFocus = (state: BoardState, delta: 1 | -1): BoardState => {
		const at = RING.indexOf(state.focus);
		const next = RING[(at + delta + RING.length) % RING.length] ?? "board";
		return next === state.focus ? state : { ...state, focus: next };
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
				fromTab: state.view.type === "detail" ? state.view.tab : undefined,
			},
		},
		effect: NONE,
	});

	// `o` in the detail view, on the task's card with events (app.tsx picks it from the host's
	// activity): its tab when it has one, so one card never shows in two places, else the event view,
	// back to this detail tab on `esc`.
	export const withTaskEvents = (
		state: BoardState,
		taskId: string,
		cardId: string,
	): BoardState =>
		state.tabs.open.includes(cardId)
			? BoardTabs.reduceMouse(state, { type: "tab", id: cardId }).state
			: {
					...state,
					view: {
						type: "events",
						cardId,
						fromView: "detail",
						fromTaskId: taskId,
						fromTab: detailTab(state.view),
					},
				};

	// The harness listed its commands again: the whole list replaces the last one, never merges.
	export const withCopilotCommands = (
		state: BoardState,
		source: string,
		commands: readonly CopilotCommand[],
	): BoardState =>
		withCopilot(state, {
			commands: commands.map((command) => ({
				name: command.name,
				hint: command.hint
					? `${command.description} · ${command.hint}`
					: command.description,
				template: `/${command.name} `,
				source,
			})),
		});

	// What a streamed update does to the board's state beyond the log: an ask joins the queue, a
	// withdrawn one leaves it, the harness's commands replace its last list, and the turn's end
	// reaches the footer's indicator. The same state for every other update.
	export const withCopilotUpdate = (
		state: BoardState,
		update: CopilotUpdate,
	): BoardState => {
		switch (update.type) {
			case "permission":
				return withCopilotPermission(state, update.request);
			case "elicitation":
				return withCopilotElicitation(state, update.request);
			case "withdrawn":
				return withCopilotWithdrawn(state, update.id);
			case "commands":
				return withCopilotCommands(state, update.source, update.commands);
			case "done":
			case "error":
				return withCopilotTurn(state, update.type);
			default:
				return state;
		}
	};

	// One row of the `/` palette: a host shortcut, which expands to its template, or a harness
	// command (`source` names the harness), which expands to `/name ` and goes as typed.
	export type PaletteEntry = CopilotShortcut & { source?: string };

	// What the palette offers, the host's shortcuts first: they are the board's own repertoire, and
	// the harness's list can run to dozens of commands and skills.
	export const paletteEntries = (
		copilot: Pick<CopilotState, "shortcuts" | "commands">,
	): PaletteEntry[] => [...copilot.shortcuts, ...copilot.commands];

	// The shortcut a `/name` prefix picks: the first whose name starts with what was typed.
	export const matchingShortcuts = (
		shortcuts: readonly PaletteEntry[],
		text: string,
	): PaletteEntry[] =>
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
	//   esc       leave the pane — it never stops the turn, the way esc destroys nothing anywhere
	//             else on the board; `x` on the transcript is the one key that stops one
	//   tab       complete a `/` being typed, else hand the ring its turn, the way a shell splits it
	//   up/down   move the `/` palette's selection, or walk this session's sent prompts
	// `enter` is the textarea's own `submit` binding and arrives through submitCopilot, not here.
	export const copilotConsumes = (
		state: BoardState,
		key: KeyInput,
	): boolean => {
		if (state.focus !== "copilot") return false;
		if (key.name === "escape" || key.name === "tab") return true;
		// A blocked harness takes the digits too: the draft in the buffer cannot be sent while a
		// turn runs anyway, so a `1` typed here is an answer, not a character. Not while a form's
		// typed field is in hand: its input, mounted in place of the buffer, takes them as text.
		const head = state.copilot.asks[0];
		if (head && askTarget(head) !== undefined && optionIndex(key) !== null)
			return true;
		if (key.name !== "up" && key.name !== "down") return false;
		// Picking from the palette beats moving a cursor through the one line that opened it. The two
		// uses cannot collide: a palette needs a leading `/`, history recall an empty buffer.
		if (
			matchingShortcuts(paletteEntries(state.copilot), state.copilot.text)
				.length > 0
		)
			return true;
		return state.copilot.text === "" && state.copilot.history.length > 0;
	};

	// Whether a key gives an answer rather than moving through one: a digit anywhere, and on the
	// copilot's form in hand every key it takes but the cursor's and `esc`, which settle nothing.
	const answers = (state: BoardState, key: KeyInput): boolean => {
		if (optionIndex(key) !== null) return true;
		if (BoardDecisions.answers(state, key)) return true;
		const head = state.copilot.asks[0];
		if (
			head?.type !== "elicitation" ||
			!askInHand(state) ||
			["escape", "up", "down"].includes(key.name)
		)
			return false;
		return ElicitationForm.reduceKey(head.request, head.draft, key) !== null;
	};

	// Which numbered choice a key names, 1-based, or null for a key that names none.
	const optionIndex = (key: KeyInput): number | null => {
		if (key.ctrl || key.meta) return null;
		const digit = Number.parseInt(key.name, 10);
		return digit >= 1 && digit <= 9 ? digit : null;
	};

	/**
	 * Whether the copilot's request waits behind a question the view has in hand — a pinned banner
	 * or a card tab's, settled or not, or a decision on the detail view (BoardDecisions). Both ask
	 * with the same digits, and a digit must answer the one being read, not whichever the router
	 * checks first. So the view's question keeps its
	 * keys while it is on screen, and the copilot's row names its request and how to reach it: focus
	 * the copilot, whose panel then asks it and takes the digits.
	 */
	export const copilotOutranked = (state: BoardState): boolean =>
		state.focus !== "copilot" &&
		(BoardTabs.inHand(state) !== undefined ||
			BoardDecisions.shown(state) !== undefined);

	/**
	 * Whether the harness's oldest request has the answer keys now: it is not outranked, and no `/`
	 * query or open prompt is taking keys as text. A form's input is focused only while this holds.
	 */
	export const askInHand = (state: BoardState): boolean =>
		state.copilot.asks.length > 0 &&
		state.search.mode !== "typing" &&
		!state.prompt.open &&
		!copilotOutranked(state);

	/** Who has the keys the copilot's ask is waiting for, and the key that hands them over. */
	export type AskReach = { key: string; holder?: string };

	/**
	 * How the copilot's oldest request gets the keys while it lacks them (askInHand), one press one
	 * level: `esc` out of an open prompt, `enter` out of a `/` query being typed, `tab` to the copilot
	 * past a question on the view. Undefined while it has them, or when nothing is asked. The ask
	 * says this in place of answer keys that would go elsewhere.
	 */
	export const askReach = (state: BoardState): AskReach | undefined => {
		if (state.copilot.asks.length === 0 || askInHand(state)) return undefined;
		if (state.prompt.open) return { key: "esc", holder: "the prompt" };
		if (state.search.mode === "typing")
			return { key: "enter", holder: "search" };
		return { key: "tab" };
	};

	/**
	 * How long a question has to be the one a digit answers before a digit does. A key already on
	 * its way when a question appears, or replaces the one being read, was aimed at what was there
	 * before; this is long enough to cover that and short enough not to be waited on.
	 */
	export const ARM_MS = 800;

	/**
	 * The id of what a digit answers right now: the copilot's oldest request unless the view's
	 * question outranks it, else that question. Undefined while the digits answer nothing — the
	 * copilot's focused textarea takes them as text.
	 */
	export const digitTarget = (state: BoardState): string | undefined => {
		const asking = state.copilot.asks[0];
		if (asking && !copilotOutranked(state)) return askTarget(asking);
		if (state.focus === "copilot") return undefined;
		return (
			BoardTabs.inHand(state)?.question.questionActivityId ??
			BoardDecisions.target(state)
		);
	};

	/**
	 * After a render: note what the digits answer now, and from when if it changed. app.tsx runs it
	 * on every committed state; the same state when nothing moved, so it re-renders nothing.
	 */
	export const sight = (state: BoardState, now: number): BoardState => {
		const target = digitTarget(state);
		return target === state.sighted.target
			? state
			: { ...state, sighted: { target, since: now } };
	};

	// Whether a digit pressed at `now` may answer: what it would answer has been on screen, as the
	// last render left it, for ARM_MS. A target no render has sighted yet is not armed.
	const armed = (state: BoardState, now: number): boolean => {
		const target = digitTarget(state);
		return (
			target === undefined ||
			(target === state.sighted.target && now - state.sighted.since >= ARM_MS)
		);
	};

	// What a digit on `ask` answers, for `sight`: a form's every field is a question of its own, so a
	// key already on its way when one field moves on to the next does not land on the next. A typed
	// field takes digits as text, so it has none to arm.
	const askTarget = (ask: CopilotAsk): string | undefined => {
		if (ask.type === "permission") return ask.request.id;
		const field = ElicitationForm.field(ask.request, ask.draft);
		return ElicitationForm.typed(field)
			? undefined
			: `${ask.request.id}#${ask.draft.at}`;
	};

	const withoutAsk = (state: BoardState, id: string): BoardState =>
		withCopilot(state, {
			asks: state.copilot.asks.filter((queued) => queued.request.id !== id),
		});

	// The keys that answer a blocked harness's permission: a digit picks its option, `esc` declines.
	// Null for everything else, which then routes as it always does — so `x` on the transcript still
	// cancels the turn, the way out when the human means to answer neither.
	const answerPermission = (
		state: BoardState,
		request: CopilotPermission,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		if (key.name === "escape") return permissionAnswered(state, request, null);
		const index = optionIndex(key);
		return index === null ? null : pickPermission(state, request, index - 1);
	};

	const permissionAnswered = (
		state: BoardState,
		request: CopilotPermission,
		optionId: string | null,
	): { state: BoardState; effect: Effect } => ({
		state: withoutAsk(state, request.id),
		effect: { type: "copilotAnswer", id: request.id, optionId },
	});

	// The permission's option at `index`, as its digit or a click names it.
	const pickPermission = (
		state: BoardState,
		request: CopilotPermission,
		index: number,
	): { state: BoardState; effect: Effect } | null => {
		const option = request.options[index];
		return option ? permissionAnswered(state, request, option.id) : null;
	};

	// A form's step: its draft moved on in the queue, or its answer sent and the form gone.
	const formStep = (
		state: BoardState,
		ask: Extract<CopilotAsk, { type: "elicitation" }>,
		step: ElicitationForm.Step,
	): { state: BoardState; effect: Effect } | null => {
		if (!step) return null;
		if ("answer" in step)
			return {
				state: withoutAsk(state, ask.request.id),
				effect: {
					type: "copilotAnswerForm",
					id: ask.request.id,
					answer: step.answer,
				},
			};
		return {
			state: withCopilot(state, {
				asks: state.copilot.asks.map((queued) =>
					queued === ask ? { ...ask, draft: step.draft } : queued,
				),
			}),
			effect: NONE,
		};
	};

	// The keys that answer the head of the queue. While a form's typed field is in hand its input
	// has the keyboard, so every key but `esc` stops here rather than also moving the board under it.
	const answerAsk = (
		state: BoardState,
		ask: CopilotAsk,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		if (ask.type === "permission")
			return answerPermission(state, ask.request, key);
		const step = formStep(
			state,
			ask,
			ElicitationForm.reduceKey(ask.request, ask.draft, key),
		);
		if (step) return step;
		return ElicitationForm.typed(ElicitationForm.field(ask.request, ask.draft))
			? { state, effect: NONE }
			: null;
	};

	// What askReach's key does, from a click: the prompt closes, the query being typed is kept as
	// `enter` keeps it, and otherwise the copilot takes the keys, which also opens its panel.
	const reachAsk = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		if (state.prompt.open)
			return { state: BoardPrompt.close(state), effect: NONE };
		if (state.search.mode === "typing")
			return reduceSearchTyping(state, state.search.query, { name: "return" });
		return { state: { ...state, focus: "copilot" }, effect: NONE };
	};

	const ASK_CLICKS: ReadonlySet<string> = new Set<AskClick["type"]>([
		"askOption",
		"askKey",
		"askReach",
	]);
	const isAskClick = (action: MouseAction): action is AskClick =>
		ASK_CLICKS.has(action.type);

	/**
	 * A click on the ask at the head of the queue, through the reducers its keys take: an option is
	 * its digit (past the ninth too), a hint is its key. A pointer aims at what is drawn, so it is not
	 * held for ARM_MS, and it answers wherever the keys are. Outranked, the ask is not drawn but its
	 * row, and any click on it hands it the keys, as `tab` does, rather than answering. A click on
	 * what says how to reach it (askReach) is the key it names.
	 */
	const clickAsk = (
		state: BoardState,
		click: AskClick,
	): { state: BoardState; effect: Effect } => {
		const ask = state.copilot.asks[0];
		const none = { state, effect: NONE };
		if (!ask) return none;
		if (click.type === "askReach") return reachAsk(state);
		if (copilotOutranked(state))
			return { state: { ...state, focus: "copilot" }, effect: NONE };
		if (click.type === "askKey")
			return answerAsk(state, ask, { name: click.name }) ?? none;
		const step =
			ask.type === "permission"
				? pickPermission(state, ask.request, click.index)
				: formStep(
						state,
						ask,
						ElicitationForm.pick(ask.request, ask.draft, click.index),
					);
		return step ?? none;
	};

	/**
	 * `enter` in the input of the form at the head of the queue, with what it holds. The same state
	 * when no form is in hand: the input belonged to a form that has since been answered or withdrawn.
	 */
	export const submitForm = (
		state: BoardState,
		text: string,
	): { state: BoardState; effect: Effect } => {
		const ask = state.copilot.asks[0];
		if (ask?.type !== "elicitation") return { state, effect: NONE };
		return (
			formStep(
				state,
				ask,
				ElicitationForm.submit(ask.request, ask.draft, text),
			) ?? {
				state,
				effect: NONE,
			}
		);
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
		const { text, at } = PromptHistory.step(history, historyAt, delta);
		return setText(state, text, { historyAt: at });
	};

	const reduceCopilotKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		switch (key.name) {
			case "escape":
				return { state: { ...state, focus: "board" }, effect: NONE };
			case "tab": {
				const picked = selectedShortcut(state);
				return picked
					? setText(state, picked.template)
					: { state: cycleFocus(state, key.shift ? -1 : 1), effect: NONE };
			}
			case "up":
				return movePalette(state, -1) ?? recall(state, 1);
			case "down":
				return movePalette(state, 1) ?? recall(state, -1);
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
		// One turn at a time; the pane says so rather than queueing behind the human's back. Never
		// silent, like every other no-op key: the draft stays in the buffer for when the turn ends,
		// and the flash names the two keys that would otherwise have to be guessed at.
		if (state.copilot.turn === "running")
			return {
				state,
				effect: {
					type: "notice",
					notice: {
						text: "a turn is running · o for its transcript, x there stops it",
						tone: "success",
					},
				},
			};
		// Expanding puts the template in front of the human to read and edit before it is sent. Any
		// open palette expands, not just an exact name: `/tr` + enter means the `/triage` under the
		// cursor, and sending the agent the literal text `/tr` is never what was meant.
		const picked = selectedShortcut(state);
		if (picked) return setText(state, picked.template);
		if (text.trim() === "") return { state, effect: NONE };
		return {
			// The board takes the keyboard back: having sent a command, the next thing the human does
			// is watch it — `o` for the transcript, j/k to look elsewhere. `A` returns here.
			state: {
				...withCopilot(state, {
					text: "",
					turn: "running",
					history: PromptHistory.push(state.copilot.history, text),
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
		state.copilot.text === text
			? state
			: withCopilot(state, { text, paletteAt: 0 });

	// The shortcut `tab` and `enter` act on: what the palette is pointing at. Clamped rather than
	// stored-and-trusted, because the list shrinks as more of the name is typed.
	export const selectedShortcut = (
		state: BoardState,
	): PaletteEntry | undefined => {
		const matches = matchingShortcuts(
			paletteEntries(state.copilot),
			state.copilot.text,
		);
		return matches[clamp(state.copilot.paletteAt, 0, matches.length - 1)];
	};

	// `up`/`down` while the palette is open. Null when there is nothing to move through, which is
	// what hands the same keys to history recall.
	const movePalette = (
		state: BoardState,
		delta: 1 | -1,
	): { state: BoardState; effect: Effect } | null => {
		const matches = matchingShortcuts(
			paletteEntries(state.copilot),
			state.copilot.text,
		);
		if (matches.length === 0) return null;
		const at = clamp(state.copilot.paletteAt, 0, matches.length - 1);
		return {
			state: withCopilot(state, {
				paletteAt: clamp(at + delta, 0, matches.length - 1),
			}),
			effect: NONE,
		};
	};

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
		// `u`'s counts, while it is on: only tasks with an open decision.
		decisions?: ReadonlyMap<string, number>,
	): SectionRows[] => {
		const query = activeQuery(search);
		// Both filters fold into ONE row predicate so the two compose: `/` narrows within the active
		// status rather than replacing it. Null while nothing narrows the list — `review` filters rows
		// just as a query does, so it takes the same tree filter (keep a flagged child's parent
		// visible, forced open).
		const matches =
			query !== "" || status === "review" || decisions !== undefined
				? (task: Task): boolean =>
						taskInStatus(task, status) &&
						(query === "" || matchesQuery(task, query)) &&
						(decisions === undefined || (decisions.get(task.id) ?? 0) > 0)
				: null;
		return sections.flatMap((section) => {
			if (!sectionInStatus(section.state, status, query)) return [];
			const rows = section.rows.flatMap((row) =>
				treeRows(row, expanded, matches),
			);
			return rows.length > 0 ? [{ section, rows }] : [];
		});
	};

	// One top-level task's rows, as visibleSections describes: unfiltered, its subtasks while it is
	// expanded; narrowed, nothing when neither it nor a subtask matches.
	const treeRows = (
		{ task, children }: BoardData.BoardRow,
		expanded: ReadonlySet<string>,
		matches: ((task: Task) => boolean) | null,
	): VisibleRow[] => {
		if (!matches)
			return parentRows(task, children, expanded.has(task.id) ? children : []);
		const parentMatch = matches(task);
		const shown =
			parentMatch && expanded.has(task.id)
				? children
				: children.filter(matches);
		return parentMatch || shown.length > 0
			? parentRows(task, children, shown)
			: [];
	};

	// A top-level row and the subtasks `shown` under it, its caret open while any are.
	const parentRows = (
		task: Task,
		children: readonly Task[],
		shown: readonly Task[],
	): VisibleRow[] => [
		{
			task,
			depth: 0,
			parentId: null,
			hasChildren: children.length > 0,
			expanded: shown.length > 0,
		},
		...shown.map((child): VisibleRow => ({
			task: child,
			depth: 1,
			parentId: task.id,
			hasChildren: false,
			expanded: false,
		})),
	];

	export const visibleRows = (state: BoardState): VisibleRow[] =>
		visibleSections(
			state.sections,
			state.expanded,
			state.search,
			state.status,
			BoardDecisions.filter(state.decisions),
		).flatMap((group) => group.rows);

	const rowOf = (
		rows: VisibleRow[],
		id: string | null,
	): VisibleRow | undefined => rows.find((r) => r.task.id === id);

	const firstId = (rows: VisibleRow[]): string | null =>
		rows[0]?.task.id ?? null;

	// A task's shortId, or its id's head when it has none or is not loaded.
	export const shortIdOf = (task: Task | undefined, id: string): string =>
		task?.shortId ?? id.slice(0, 8);

	const shortId = (task: Task): string => shortIdOf(task, task.id);

	// Find a task anywhere in the board (top-level or subtask) by id — the detail view's action target,
	// which may be a subtask and isn't addressable by the board's selection.
	export const taskById = (state: BoardState, id: string): Task | undefined => {
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
		task: Task,
		delta: number,
	): { state: BoardState; effect: Effect } => {
		const progression: readonly TaskState[] = BoardData.STATE_PROGRESSION;
		const current = progression.indexOf(task.state);
		const target = BoardData.STATE_PROGRESSION[current + delta];
		if (current < 0 || !target) return { state, effect: NONE };
		return {
			state: withUndo(state, stateUndoEntry(task)),
			effect: {
				type: "setState",
				id: task.id,
				state: target,
				notice: `${shortId(task)} → ${target}`,
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
			tabs: BoardTabs.NONE,
			marked: new Set<string>(),
			announcement: null,
			decisions: BoardDecisions.NONE,
			checklist: BoardChecklist.NONE,
			copilot: COPILOT_IDLE,
			prompt: BoardPrompt.CLOSED,
			undo: [],
			sighted: { target: undefined, since: 0 },
		};
		return { ...base, selectedId: firstId(visibleRows(base)) };
	};

	// Where `id` has its row: the section it is in, and the parent it sits under when it is a
	// subtask there. A subtask's section is its parent's, whatever its own state.
	const rowPlace = (
		state: BoardState,
		id: string,
	): { section: BoardData.SectionState; parentId?: string } | undefined => {
		for (const section of state.sections) {
			for (const { task, children } of section.rows) {
				if (task.id === id) return { section: section.state };
				if (children.some((child) => child.id === id))
					return { section: section.state, parentId: task.id };
			}
		}
		return undefined;
	};

	/**
	 * Open `taskId`'s detail the way `enter` on its row would, from wherever the board is: help, the
	 * dispatch picker or form, a card's or a question's prompt and a `/` being typed close, the board
	 * takes the keys, and the copilot's draft and asks are kept. When the task is loaded, the board
	 * under the detail is left showing its row, selected: its parent expanded, the current status
	 * filter when that shows it, else the one holding its section, and a search or `u` that hides it
	 * cleared, so `esc` lands on it. A task outside the loaded sections still opens, from its own
	 * records; bringing it in takes a reload, which is the caller's to run.
	 */
	export const openTask = (state: BoardState, taskId: string): BoardState => {
		const opened: BoardState = {
			...BoardPrompt.close(state),
			help: false,
			dispatch: null,
			focus: "board",
			search: state.search.mode === "typing" ? SEARCH_OFF : state.search,
			view: { type: "detail", taskId },
		};
		const place = rowPlace(state, taskId);
		if (!place) return opened;
		const at = (status: StatusFilter): BoardState => ({
			...opened,
			status,
			expanded: place.parentId
				? setExpanded(state, place.parentId, true)
				: state.expanded,
			selectedId: taskId,
		});
		const shows = (s: BoardState): boolean =>
			rowOf(visibleRows(s), taskId) !== undefined;
		const kept = at(state.status);
		if (shows(kept)) return kept;
		const holding = at(BoardData.isClosed(place.section) ? "done" : "open");
		return shows(holding)
			? holding
			: { ...BoardDecisions.clear(holding), search: SEARCH_OFF };
	};

	// Merge freshly loaded sections into an existing state, keeping the same task selected and the same
	// parents expanded across the reload. If the selected task vanished (a state move out of the visible
	// sections, or a drop past the done cap), re-anchor to the nearest surviving row by its old position
	// rather than the top. Stale expanded ids are harmless (visibleRows ignores parents that no longer
	// exist). The poll's open-decision counts land in the same pass when it read them: under `u` they
	// decide which rows are visible, so the selection is reconciled against both at once.
	export const withSections = (
		state: BoardState,
		sections: BoardData.BoardSection[],
		counts?: ReadonlyMap<string, number>,
	): BoardState => {
		const next = BoardDecisions.withCounts({ ...state, sections }, counts);
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
	//
	// `now` is when the key arrived, on the same clock `sight` stamps renders with.
	export const reduceKey = (
		state: BoardState,
		key: KeyInput,
		now: number,
	): { state: BoardState; effect: Effect } => {
		if (state.help) return reduceHelpKey(state, key);
		if (state.dispatch?.form)
			return TriggerForm.reduceKey(state, state.dispatch.form, key);
		if (state.dispatch) return reduceDispatchKey(state, state.dispatch, key);
		if (answersUnread(state, key, now))
			return { state, effect: { type: "notice", notice: justAsked() } };
		// A harness blocked on a question is the most urgent thing on screen, so it takes the keys
		// that answer it — a digit, `esc`, a form's cursor — ahead of every view and of the copilot's
		// own focus. That is the esc layering the board already has, one press one level: the newest,
		// most local thing goes first, and here it is the thing something else is waiting on.
		// Search-typing and an open prompt are the exceptions: a digit is a character there, and the
		// prompt's `esc` closes it, and so is a session question the view has in hand
		// (copilotOutranked). Every other key falls through.
		if (askInHand(state)) {
			const asking = state.copilot.asks[0];
			const answered = asking ? answerAsk(state, asking, key) : null;
			if (answered) return answered;
		}
		// The copilot owns the keyboard while focused, and decides for itself what `tab` means there.
		// An open prompt has the keyboard the same way, its textarea taking what it does not.
		if (state.prompt.open) return BoardPrompt.reduceKey(state, key);
		if (state.focus === "copilot") return reduceCopilotKey(state, key);
		if (clearsTurnIndicator(state, key))
			return reduceKey(withCopilotTurn(state, "idle"), key, now);
		// A decision on the detail view takes the keys its form answers ahead of every view's, and
		// all of them while its input is typed into, the `?` and `{}` of the everywhere keys included.
		const deciding = BoardDecisions.reduceKey(state, key);
		if (deciding) return deciding;
		// ctrl-z routes across every view (board + detail), after the modals own the keyboard and before
		// view routing. Inert while a `/` query is being typed (ctrl isn't a printable query char anyway).
		if (isUndoKey(key) && state.search.mode !== "typing")
			return reduceUndo(state);
		// Focus-level keys, once for every view. All are query characters while a `/` search is being
		// typed, so the whole group defers to that branch inside reduceBoardKey.
		const everywhere =
			state.search.mode === "typing" ? null : reduceEverywhereKey(state, key);
		return everywhere ?? reduceViewKey(state, key);
	};

	// A digit answers only a question that has been on screen long enough to read: one that just
	// appeared, or just replaced the one in hand, holds the key and says so rather than taking an
	// answer the human never saw. So does every other key that answers a form (`enter` picks the
	// cursor's option). Search-typing and an open prompt take a digit as a character. A shifted
	// digit is no answer (`!` on some terminals), so it passes.
	const answersUnread = (
		state: BoardState,
		key: KeyInput,
		now: number,
	): boolean =>
		answers(state, key) &&
		!key.shift &&
		state.search.mode !== "typing" &&
		!state.prompt.open &&
		!armed(state, now);

	// A fresh object each time: the footer restarts its timer only when the notice it holds changes,
	// so a second blocked press must not hand it the same object.
	const justAsked = (): Notice => ({
		text: "just asked · read it, then press again",
		tone: "success",
	});

	// A finished turn's footer indicator stays up until the next keypress — except `o`, which is the
	// key that opens it, and the search box, where a keypress is a query character.
	const clearsTurnIndicator = (state: BoardState, key: KeyInput): boolean =>
		(state.copilot.turn === "done" || state.copilot.turn === "error") &&
		key.name !== "o" &&
		state.search.mode !== "typing";

	// The keys that mean the same in every view: which pane has the keyboard, and which tab is on
	// screen, are not a property of what is on screen. Null for every other key.
	const reduceEverywhereKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		if (isHelpKey(key))
			return { state: { ...state, help: true }, effect: NONE };
		if (isCopilotKey(key)) return focusCopilot(state);
		// Also view-agnostic: `O` acts on the task in hand, which is the open one in detail and the
		// selected row everywhere else.
		if (isOpenLinkKey(key)) return openLink(state);
		if (key.name === "tab")
			return { state: cycleFocus(state, key.shift ? -1 : 1), effect: NONE };
		// The tab bar's keys: which tab is on screen is not a view's business.
		return BoardTabs.reduceGlobalKey(state, key);
	};

	// The view's own keys. A banner pinned over the detail view takes the keys that answer it first,
	// and a card's tab answers its own before the event view under it does.
	const reduceViewKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		const { view, tabs } = state;
		if (view.type === "detail" && view.banner) {
			const answered = BoardTabs.reduceBannerKey(state, view.banner, key);
			if (answered) return answered;
		}
		if (view.type === "events") {
			const own =
				tabs.active === null
					? null
					: (BoardTabs.reduceCardTabKey(state, tabs.active, key) ??
						CardTab.reduceKey(state, tabs.active, key));
			return own ?? reduceEventsKey(state, key);
		}
		return view.type === "detail"
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

	// Event view: j/k scroll, `t` opens or closes every tool row, esc/q pop back to the previous view.
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
						? {
								type: "detail" as const,
								taskId: state.view.fromTaskId,
								tab: state.view.fromTab,
							}
						: { type: "board" as const };
				return { state: { ...state, view: back }, effect: NONE };
			}
			case "j":
			case "down":
				return { state, effect: { type: "scroll", delta: 2 } };
			case "k":
			case "up":
				return { state, effect: { type: "scroll", delta: -2 } };
			case "t":
				return {
					state: {
						...state,
						view: { ...state.view, toolDetails: !state.view.toolDetails },
					},
					effect: NONE,
				};
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

	// The `?` sheet: `?`, esc or q closes it, j/k scroll it when it is taller than the pane; everything
	// else is inert (modal, same as dispatch).
	const reduceHelpKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (isHelpKey(key) || key.name === "escape" || key.name === "q") {
			return { state: { ...state, help: false }, effect: NONE };
		}
		switch (key.name) {
			case "j":
			case "down":
				return { state, effect: { type: "helpScroll", delta: SCROLL_STEP } };
			case "k":
			case "up":
				return { state, effect: { type: "helpScroll", delta: -SCROLL_STEP } };
			default:
				return { state, effect: NONE };
		}
	};

	// Whose keys are live right now, in the order reduceKey hands them out: a modal first, then the
	// pane with focus, then the view. The footer shows this context's hints and `?` opens its sheet.
	export const keyContext = (state: BoardState): Keymap.ContextId => {
		if (state.dispatch)
			return state.dispatch.form ? "dispatchForm" : "dispatch";
		if (state.prompt.open) return "prompt";
		if (state.focus === "copilot")
			return matchingShortcuts(
				paletteEntries(state.copilot),
				state.copilot.text,
			).length > 0
				? "palette"
				: "copilot";
		if (state.search.mode === "typing") return "search";
		if (state.view.type === "events")
			return state.tabs.active === null ? "transcript" : "cardTab";
		if (state.view.type === "detail")
			return BoardDecisions.typing(state) ? "decisionText" : "detail";
		return state.search.mode === "committed" ? "searchResults" : "board";
	};

	/** The context the `?` sheet lists: a committed search is still the board, keys and all. */
	export const sheetContext = (state: BoardState): Keymap.ContextId => {
		const context = keyContext(state);
		return context === "searchResults" ? "board" : context;
	};

	/**
	 * The facts that decide which keys do something right now. `linked` and `events` come from the
	 * host's data, which app.tsx holds and the reducer does not: the tasks pointing at an external
	 * issue, whether the open task has host activity to read, and whether the card on screen has a
	 * header of its host's.
	 */
	export const keySituation = (
		state: BoardState,
		facts: { linked: ReadonlySet<string>; events: boolean; header?: boolean },
	): Keymap.Situation => {
		const inHand =
			state.view.type === "detail"
				? state.view.taskId
				: rowOf(visibleRows(state), state.selectedId)?.task.id;
		const card = CardTab.situation(state);
		return {
			selection: rowOf(visibleRows(state), state.selectedId) !== undefined,
			linked: inHand !== undefined && facts.linked.has(inHand),
			events: facts.events,
			header: facts.header === true,
			transcript: state.copilot.hasLog,
			stoppable: turnStoppable(state) || card.stoppable,
			clearable:
				state.marked.size > 0 ||
				state.search.mode === "committed" ||
				state.decisions.only ||
				state.announcement !== null ||
				state.scoped,
			decisions: BoardDecisions.listed(state),
			deciding: BoardDecisions.keysInHand(state),
			checklist: BoardChecklist.listed(state),
			history: recallable(state.prompt.open ? state.prompt : state.copilot),
			reaimable: (state.prompt.open?.aims?.length ?? 0) > 1,
			ready:
				state.dispatch !== null &&
				!state.dispatch.loading &&
				state.dispatch.triggers.length > 0,
			...BoardTabs.situation(state),
			lanes: card.lanes,
		};
	};

	// `x` on the copilot's transcript while its turn runs.
	const turnStoppable = (state: BoardState): boolean =>
		state.view.type === "events" &&
		state.view.cardId === CopilotLog.CARD_ID &&
		state.copilot.turn === "running";

	// `up` has something to recall: an empty buffer, and something sent before.
	const recallable = (input: {
		text: string;
		history: readonly string[];
	}): boolean => input.text === "" && input.history.length > 0;

	// Dispatch overlay: one list of host triggers. While loading only esc works; then j/k and 1-9
	// select, enter fires a satisfiable trigger (an unsatisfiable one flashes its hint), or opens its
	// form when the board can fill it in, and esc closes.
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
				if (TriggerForm.fillable(trigger))
					return {
						state: {
							...state,
							dispatch: { ...overlay, form: TriggerForm.open(trigger) },
						},
						effect: NONE,
					};
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
	// The task `O` acts on: the open one in the detail view, the selected row in every other. Nothing
	// selected is a no-op rather than a notice — there is no task to say anything about.
	const openLink = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const id =
			state.view.type === "detail"
				? state.view.taskId
				: rowOf(visibleRows(state), state.selectedId)?.task.id;
		return id
			? { state, effect: { type: "openLink", id } }
			: { state, effect: NONE };
	};

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

	// `[copy]`: the open task in the detail view, else the selected row.
	const copyClick = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		const id =
			state.view.type === "detail" ? state.view.taskId : state.selectedId;
		return id
			? { state, effect: { type: "copy", id } }
			: { state, effect: NONE };
	};

	// Mouse router, parallel to reduceKey. Board-only actions (`select`, `toggleExpand`) no-op while the
	// detail view is open (those handlers unmount with the board); `copy` is valid in both views. All
	// mouse input is inert while a true modal (dispatch, help) is open, same as keys, but for the
	// trigger form's fields, which are rows like the board's. The copilot is not a modal: a click lands
	// on the board, so it brings focus along with it.
	export const reduceMouse = (
		incoming: BoardState,
		action: MouseAction,
	): { state: BoardState; effect: Effect } => {
		if (action.type === "formField")
			return TriggerForm.click(incoming, action.index);
		if (incoming.help || incoming.dispatch)
			return { state: incoming, effect: NONE };
		// Putting the announcement away is not choosing a pane: focus and an open prompt stay put.
		if (action.type === "announcement")
			return { state: { ...incoming, announcement: null }, effect: NONE };
		// Answering the copilot is not working on the board: the keys stay where they were.
		if (isAskClick(action)) return clickAsk(incoming, action);
		// A click is the human saying they are working on the board now: the copilot loses focus and an
		// open prompt closes.
		const state: BoardState = BoardPrompt.close(
			incoming.focus === "board" ? incoming : { ...incoming, focus: "board" },
		);
		if (action.type === "copy") return copyClick(state);
		if (action.type === "detailTab")
			return state.view.type === "detail"
				? withDetailTab(state, action.tab)
				: { state, effect: NONE };
		if (action.type === "tab" || action.type === "answer")
			return BoardTabs.reduceMouse(state, action);
		if (action.type === "lane") return CardTab.reduceLane(state, action.index);
		// A hint the decision hands on goes where its key would: `esc back` to the view's `esc`.
		if (action.type === "decisionKey")
			return (
				BoardDecisions.click(state, action) ??
				reduceViewKey(state, { name: action.name })
			);
		if (action.type === "decisionOption" || action.type === "decisionReach")
			return BoardDecisions.click(state, action) ?? { state, effect: NONE };
		if (action.type === "checklistItem")
			return BoardChecklist.click(state, action.id);
		return state.view.type === "board"
			? clickRow(state, action)
			: { state, effect: NONE };
	};

	// A click on the board's list, on the row at its visible index.
	const clickRow = (
		state: BoardState,
		action: Extract<MouseAction, { type: "select" | "toggleExpand" }>,
	): { state: BoardState; effect: Effect } => {
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

	// A detail view on `tab`. The same state back when it already is, so the caller skips a render.
	const withDetailTab = (
		state: BoardState,
		tab: DetailModel.Tab,
	): { state: BoardState; effect: Effect } =>
		state.view.type !== "detail" || detailTab(state.view) === tab
			? { state, effect: NONE }
			: { state: { ...state, view: { ...state.view, tab } }, effect: NONE };

	// Detail view: `esc`/`q` pop back to the board (never widen scope or quit); j/k/up/down scroll the
	// tab in view; a digit picks a tab and `h`/`l` (or left/right) step through them; on the
	// description, `J/K` move through the checklist and `space` toggles an item; the keys for the
	// task in hand act on the OPEN task (not the board's selection), and the view refreshes after a
	// mutation; everything else is a no-op.
	const reduceDetailKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.view.type !== "detail") return { state, effect: NONE };
		const { taskId } = state.view;
		// The checklist's keys, `space` and `J/K`, ahead of `j/k`, which `J` and `K` are shifted from.
		const ticked = BoardChecklist.reduceKey(state, key);
		if (ticked) return ticked;
		const digitTab = DetailModel.tabAt(Number.parseInt(key.name, 10));
		if (digitTab) return withDetailTab(state, digitTab);
		switch (key.name) {
			case "h":
			case "left":
				return withDetailTab(
					state,
					DetailModel.stepTab(detailTab(state.view), -1),
				);
			case "l":
			case "right":
				return withDetailTab(
					state,
					DetailModel.stepTab(detailTab(state.view), 1),
				);
			case "escape":
			case "q":
				return { state: { ...state, view: { type: "board" } }, effect: NONE };
			case "j":
			case "down":
				return { state, effect: { type: "scroll", delta: SCROLL_STEP } };
			case "k":
			case "up":
				return { state, effect: { type: "scroll", delta: -SCROLL_STEP } };
			case "o":
				// The copilot's transcript wins while its indicator is up; otherwise the task's events.
				return state.copilot.turn === "idle"
					? { state, effect: { type: "openEvents", taskId } }
					: openCopilotEvents(state);
			default:
				return (
					reduceInHandKey(state, taskId, taskById(state, taskId), key) ?? {
						state,
						effect: NONE,
					}
				);
		}
	};

	// The keys for the task in hand, the open one in the detail view and the selected row on the board:
	// `y` copies its brief, `m` marks it, `a` opens the dispatch overlay on it, and the status keys
	// (`v`/`x`/`n`/`s`) act on it. `task` is undefined while the open task is not loaded, which leaves
	// the status keys nothing to act on. Null for every other key.
	const reduceInHandKey = (
		state: BoardState,
		id: string,
		task: Task | undefined,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		switch (key.name) {
			case "y":
				return { state, effect: { type: "copy", id } };
			case "m":
				return toggleMark(state, id);
			case "a":
				return openDispatch(state, id);
			case "v":
				return reviewTask(state, task);
			case "x":
				return jumpState(state, task, "cancelled", "cancelled");
			case "n":
				return jumpState(state, task, "next", "→ next");
			case "s":
				return jumpState(state, task, "someday", "→ someday");
			default:
				return null;
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

	const reduceBoardKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		if (state.search.mode === "typing")
			return reduceSearchTyping(state, state.search.query, key);
		switch (key.name) {
			case "q":
				return { state, effect: { type: "quit" } };
			case "r":
				return { state, effect: { type: "reload" } };
			case "i":
				return {
					state: { ...state, kind: nextKind(state.kind) },
					effect: { type: "reload" },
				};
			// No reload, unlike `i`: every state is already loaded each poll (done capped to its recent
			// window) and every row already carries needsReview, so `f` filters rows in hand.
			case "f":
				return withStatus(state, nextStatus(state.status));
			// Like `f`, filters rows in hand: every poll already counts the open decisions.
			case "u":
				return {
					state: withSelection(BoardDecisions.toggle(state), state.selectedId),
					effect: NONE,
				};
			case "/":
				// Enter search-input mode with a fresh query (vim idiom — `/` always starts over).
				return {
					state: { ...state, search: { mode: "typing", query: "" } },
					effect: NONE,
				};
			case "escape":
				return clearOneLevel(state);
			case "o":
				// The board has no per-task events; `o` here is the copilot's transcript, when there is
				// one. Guarded on the LOG, not the turn: the indicator clears on the next keypress, and
				// guarding on that made the session's turns unreachable the moment you pressed anything.
				return state.copilot.hasLog
					? openCopilotEvents(state)
					: { state, effect: NONE };
			default:
				return reduceTreeKey(state, key) ?? reduceRowKey(state, key);
		}
	};

	// Esc layering on the board, one esc one level: marks clear first (the most recent, most local
	// thing the human added), then a committed search, then the decisions filter, then the host's
	// announcement, then scope widens. Marks therefore never survive into a widened list they were not picked from, and
	// dismissing the announcement never widens the scope too. (Typing-mode esc never reaches here;
	// reduceSearchTyping owns it.)
	const clearOneLevel = (
		state: BoardState,
	): { state: BoardState; effect: Effect } => {
		if (state.marked.size > 0)
			return { state: { ...state, marked: NO_MARKS }, effect: NONE };
		if (state.search.mode === "committed") return withSearch(state, SEARCH_OFF);
		if (state.decisions.only)
			return {
				state: withSelection(BoardDecisions.clear(state), state.selectedId),
				effect: NONE,
			};
		if (state.announcement !== null)
			return { state: { ...state, announcement: null }, effect: NONE };
		return state.scoped
			? { state: { ...state, scoped: false }, effect: { type: "reload" } }
			: { state, effect: NONE };
	};

	// j/k move the selection; space, `l` and `h` open and close the selected parent. Null for every
	// other key.
	const reduceTreeKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } | null => {
		switch (key.name) {
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
			default:
				return null;
		}
	};

	// The selected row's keys: `enter` opens it, `d` marks it done, `[`/`]` step its state, and the
	// keys for the task in hand. With nothing selected, none of them does anything.
	const reduceRowKey = (
		state: BoardState,
		key: KeyInput,
	): { state: BoardState; effect: Effect } => {
		const task = rowOf(visibleRows(state), state.selectedId)?.task;
		if (!task) return { state, effect: NONE };
		switch (key.name) {
			case "return":
			case "enter":
				return {
					state: { ...state, view: { type: "detail", taskId: task.id } },
					effect: NONE,
				};
			case "d":
				return {
					state: withUndo(state, stateUndoEntry(task)),
					effect: {
						type: "markDone",
						id: task.id,
						notice: `${shortId(task)} done`,
					},
				};
			case "[":
				return shiftState(state, task, -1);
			case "]":
				return shiftState(state, task, 1);
			default:
				return (
					reduceInHandKey(state, task.id, task, key) ?? { state, effect: NONE }
				);
		}
	};
}
