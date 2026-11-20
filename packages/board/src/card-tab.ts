// A host card's own tab, past what the tab bar decides (tabs.ts, which also answers the question the
// tab shows): which of its lanes is on screen, whether its header is expanded, and the actions it
// offers. Plain functions over the board's state, like the rest of the key routing, so the keys and
// the mouse are tested without a renderer.
//
// Lanes are the card's named streams (one per agent session, say). Lane 0 is all of them, live; then
// each lane in the host's order. The lane on screen is kept by NAME per card, so a lane the host adds
// does not shift what the human was reading, and coming back to the tab finds it where it was left.
//
// A card with steps (`ActivityCard.steps`) is a map instead: `j/k` move a cursor over its steps
// and sessions, `h/l` fold and open a step, `enter` opens the session under the cursor's log in
// place of the stream (`esc` closes it before going back to the tracker), and `f` hands the cursor
// back to the run (RunMap). The lane chips and `e` are for a card without steps.
//
// Actions are the host's keys. The board's own keys on a card's tab come first and cannot be taken,
// and `x` is reserved for the host's `stop` action, as it stops the copilot's turn on its transcript.
// An action with `input` opens the board's prompt (prompt.ts) and sends what was typed.
import { type CardAction, type StopAction } from "@kabane/extension";
import type { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { BoardPrompt } from "./prompt";
import { RunMap } from "./run-map";
import { BoardTabs } from "./tabs";

const STOP_ACTION: StopAction = "stop";

export namespace CardTab {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	const NOTHING: BoardNav.Effect = { type: "none" };
	const UNREAD: BoardTabs.CardView = { lane: null, expanded: false };

	// Keys the board answers on a card's tab, whatever a host binds: an action under one is never
	// offered. `x` is the stop action's alone.
	const RESERVED: ReadonlySet<string> = new Set([
		..."xhlewoqjkgGtf{}!?A:O,0123456789",
		"escape",
		"return",
		"tab",
		"up",
		"down",
		"left",
		"right",
	]);

	/** How the card's tab is being read: its lane on screen and whether its header is expanded. */
	export const view = (tabs: BoardTabs.Tabs, id: string): BoardTabs.CardView =>
		tabs.views.get(id) ?? UNREAD;

	const lanesOf = (tabs: BoardTabs.Tabs, id: string): readonly string[] =>
		tabs.cards.get(id)?.lanes ?? [];

	/** The lane on screen as a chip index: 0 for every lane, else its place in the host's list + 1. */
	const laneIndex = (tabs: BoardTabs.Tabs, id: string): number => {
		const { lane } = view(tabs, id);
		return lane === null ? 0 : lanesOf(tabs, id).indexOf(lane) + 1;
	};

	const withView = (
		state: State,
		id: string,
		patch: Partial<BoardTabs.CardView>,
	): State => {
		const views = new Map(state.tabs.views).set(id, {
			...view(state.tabs, id),
			...patch,
		});
		return { ...state, tabs: { ...state.tabs, views } };
	};

	const withLane = (state: State, id: string, index: number): State => {
		const lane = lanesOf(state.tabs, id)[index - 1] ?? null;
		return lane === view(state.tabs, id).lane
			? state
			: withView(state, id, { lane });
	};

	// `e`: the host's header, compact or in full. The board does not know whether the card's kind
	// has a header; without one the toggle is kept and shows nothing.
	const toggleHeader = (state: State, id: string): Step => ({
		state: withView(state, id, { expanded: !view(state.tabs, id).expanded }),
		effect: NOTHING,
	});

	// `h`/`l`: the previous or next lane, every lane included, wrapping both ways.
	const stepLane = (state: State, id: string, delta: 1 | -1): Step | null => {
		const count = lanesOf(state.tabs, id).length + 1;
		if (count === 1) return null;
		const at = (laneIndex(state.tabs, id) + delta + count) % count;
		return { state: withLane(state, id, at), effect: NOTHING };
	};

	/** The actions a key can reach on the card's tab, `stop` included. */
	const actionsOf = (tabs: BoardTabs.Tabs, id: string): readonly CardAction[] =>
		(tabs.cards.get(id)?.actions ?? []).filter((action) =>
			action.id === STOP_ACTION ? true : !RESERVED.has(action.key),
		);

	const notice = (state: State, text: string): Step => ({
		state,
		effect: { type: "notice", notice: { text, tone: "success" } },
	});

	const isMap = (tabs: BoardTabs.Tabs, id: string): boolean =>
		(tabs.cards.get(id)?.steps?.length ?? 0) > 0;

	/** The lanes the card's questions wait on, which the map's cursor goes to first. */
	export const asking = (
		tabs: BoardTabs.Tabs,
		id: string,
	): ReadonlySet<string> =>
		new Set(
			tabs.queue.flatMap((q) =>
				q.cardId === id && q.lane !== undefined ? [q.lane] : [],
			),
		);

	const mapRow = (tabs: BoardTabs.Tabs, id: string): RunMap.Row | undefined =>
		RunMap.at(tabs.cards.get(id) ?? {}, view(tabs, id), asking(tabs, id));

	/**
	 * The lanes an action aimed at a lane can go to from the tab: the one on screen, else on a map the
	 * live session under the cursor, else the live ones.
	 */
	const aimsOf = (tabs: BoardTabs.Tabs, id: string): readonly string[] => {
		const { lane } = view(tabs, id);
		if (lane !== null) return [lane];
		const live = tabs.cards.get(id)?.liveLanes;
		const row = isMap(tabs, id) ? mapRow(tabs, id) : undefined;
		if (
			row?.type === "session" &&
			row.session.lane &&
			live?.includes(row.session.lane)
		)
			return [row.session.lane];
		return live ?? lanesOf(tabs, id);
	};

	// One of the card's actions: straight to the host, or through the prompt when it takes text. One
	// aimed at a lane goes to the lane on screen; on the all-lanes view, to the only live one, or
	// through its prompt aimed at the first, `tab` walking the others.
	const run = (state: State, id: string, action: CardAction): Step => {
		const card = state.tabs.cards.get(id);
		const noun = card?.laneNoun ?? "lanes";
		const aims = action.lane ? aimsOf(state.tabs, id) : [];
		if (action.lane && aims.length === 0)
			return notice(state, `no ${noun} to ${action.label} now`);
		if (action.lane && aims.length > 1 && action.input === undefined)
			return notice(
				state,
				`${action.label} goes to one of the ${noun} · ${isMap(state.tabs, id) ? "the cursor" : "h/l"} picks it`,
			);
		const lane = action.lane
			? aims[0]
			: (view(state.tabs, id).lane ?? undefined);
		if (action.input !== undefined)
			return BoardPrompt.open(state, {
				target: {
					type: "act",
					cardId: id,
					actionId: action.id,
					...(lane ? { lane } : {}),
				},
				title: action.label,
				...(lane ? { aim: lane } : {}),
				...(aims.length > 1 ? { aims } : {}),
				placeholder: action.input,
			});
		return {
			state,
			effect: {
				type: "act",
				cardId: id,
				actionId: action.id,
				...(lane ? { lane } : {}),
			},
		};
	};

	// `x`: the card's stop action, while it has one and is still going. Reserved either way.
	const stop = (state: State, id: string): Step => {
		const action = actionsOf(state.tabs, id).find((a) => a.id === STOP_ACTION);
		return action && !state.tabs.cards.get(id)?.finished
			? run(state, id, action)
			: { state, effect: NOTHING };
	};

	const keyOf = (key: BoardNav.KeyInput): string => key.sequence ?? key.name;

	const NO_FOLDS: ReadonlyMap<string, boolean> = new Map();

	// Fold (`open` false) or open the step under the cursor; on a session, folding its step puts the
	// cursor on the step's row.
	const fold = (state: State, id: string, open: boolean): Step | null => {
		const row = mapRow(state.tabs, id);
		const card = state.tabs.cards.get(id);
		const step =
			row?.type === "step"
				? row.step
				: row?.type === "session"
					? card?.steps?.find((s) => RunMap.stepKey(s) === row.parent)
					: undefined;
		if (!row || !step || (open && row.type !== "step")) return null;
		const folds = new Map(view(state.tabs, id).folds ?? NO_FOLDS).set(
			step.name,
			open,
		);
		return {
			state: withView(state, id, {
				folds,
				cursor: RunMap.stepKey(step),
				follow: false,
			}),
			effect: NOTHING,
		};
	};

	// `enter`: the session under the cursor's log over the stream, a step opened or folded, an issue
	// left for the human opened on the tracker.
	const enter = (state: State, id: string): Step | null => {
		const row = mapRow(state.tabs, id);
		switch (row?.type) {
			case "session":
				return row.session.lane
					? {
							state: withView(state, id, { lane: row.session.lane }),
							effect: NOTHING,
						}
					: null;
			case "step":
				return fold(state, id, !row.open);
			case "left": {
				const taskId = row.item.taskId;
				return taskId
					? { state: BoardTabs.openTask(state, taskId), effect: NOTHING }
					: null;
			}
			default:
				return null;
		}
	};

	// The map's own keys; null for any other, and for these on a map with no rows.
	const reduceMapKey = (
		state: State,
		id: string,
		name: string,
	): Step | null => {
		const card = state.tabs.cards.get(id) ?? {};
		const current = view(state.tabs, id);
		const moveBy = (delta: 1 | -1): Step | null => {
			const cursor = RunMap.move(card, current, delta, asking(state.tabs, id));
			return cursor === undefined
				? null
				: {
						state: withView(state, id, { cursor, follow: false }),
						effect: NOTHING,
					};
		};
		switch (name) {
			case "j":
			case "down":
				return moveBy(1);
			case "k":
			case "up":
				return moveBy(-1);
			case "h":
			case "left":
				return fold(state, id, false) ?? { state, effect: NOTHING };
			case "l":
			case "right":
				return fold(state, id, true) ?? { state, effect: NOTHING };
			case "return":
			case "enter":
				return enter(state, id);
			case "f":
				return {
					state: withView(state, id, { follow: true }),
					effect: NOTHING,
				};
			case "e":
				return { state, effect: NOTHING };
			default:
				return null;
		}
	};

	/** `esc` on a map's session log: back to the stream, before `esc` goes to the tracker. */
	export const closeLog = (
		state: State,
		id: string,
		key: BoardNav.KeyInput,
	): Step | null =>
		key.name === "escape" &&
		isMap(state.tabs, id) &&
		view(state.tabs, id).lane !== null
			? { state: withView(state, id, { lane: null }), effect: NOTHING }
			: null;

	/**
	 * A click on a map row: the first puts the cursor there, one on the cursor's row is `enter`.
	 */
	export const reduceMapRow = (state: State, key: string): Step => {
		const id = state.tabs.active;
		if (id === null || !isMap(state.tabs, id))
			return { state, effect: NOTHING };
		const card = state.tabs.cards.get(id) ?? {};
		if (
			RunMap.cursor(card, view(state.tabs, id), asking(state.tabs, id)) === key
		)
			return enter(state, id) ?? { state, effect: NOTHING };
		return {
			state: withView(state, id, { cursor: key, follow: false }),
			effect: NOTHING,
		};
	};

	/** The card's own keys on its tab. Null for the keys the event view under it answers (j/k). */
	export const reduceKey = (
		state: State,
		id: string,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (key.ctrl || key.meta) return null;
		// A letter by what it types: OpenTUI names `X` as `x` with shift, which is not stop. A named
		// key (`left`, `return`) by its name, its sequence being an escape code.
		const name = key.name.length === 1 ? keyOf(key) : key.name;
		if (isMap(state.tabs, id)) {
			const mapped = reduceMapKey(state, id, name);
			if (mapped) return mapped;
		}
		switch (name) {
			case "h":
			case "left":
				return stepLane(state, id, -1);
			case "l":
			case "right":
				return stepLane(state, id, 1);
			case "x":
				return stop(state, id);
			case "e":
				return toggleHeader(state, id);
			default: {
				const action = actionsOf(state.tabs, id).find(
					(a) => a.id !== STOP_ACTION && a.key === keyOf(key),
				);
				return action ? run(state, id, action) : null;
			}
		}
	};

	/** A click on the `index`th lane chip of the tab on screen (0 is every lane). */
	export const reduceLane = (state: State, index: number): Step => {
		const id = state.tabs.active;
		const known = id !== null && index <= lanesOf(state.tabs, id).length;
		return known && index >= 0
			? { state: withLane(state, id, index), effect: NOTHING }
			: { state, effect: NOTHING };
	};

	/**
	 * The footer's hints for the card on screen's own actions, `stop` left to the registry's `x`.
	 * Only while the tab has the keys: under an open prompt or the copilot's focus they would be
	 * typed into a textarea.
	 */
	export const hints = (state: State): Keymap.Hint[] => {
		const id = state.tabs.active;
		if (id === null || BoardNav.keyContext(state) !== "cardTab") return [];
		// An action aimed at a lane, with none it can go to, has nothing to say in the footer.
		const aimed = aimsOf(state.tabs, id).length > 0;
		return actionsOf(state.tabs, id)
			.filter((action) => action.id !== STOP_ACTION)
			.filter((action) => !action.lane || aimed)
			.map((action) => ({ key: action.key, label: action.label }));
	};

	/** Facts the footer's `when`s read, about the card on screen. */
	export const situation = (
		state: State,
	): { lanes: boolean; stoppable: boolean; map: boolean; log: boolean } => {
		const id = state.tabs.active;
		if (id === null || state.view.type !== "events")
			return { lanes: false, stoppable: false, map: false, log: false };
		const map = isMap(state.tabs, id);
		return {
			map,
			log: map && view(state.tabs, id).lane !== null,
			lanes: !map && lanesOf(state.tabs, id).length > 0,
			stoppable:
				!state.tabs.cards.get(id)?.finished &&
				actionsOf(state.tabs, id).some((a) => a.id === STOP_ACTION),
		};
	};
}
