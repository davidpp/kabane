// A host card's own tab, past what the tab bar decides (tabs.ts, which also answers the question the
// tab shows): which of its lanes is on screen, whether its header is expanded, and the actions it
// offers. Plain functions over the board's state, like the rest of the key routing, so the keys and
// the mouse are tested without a renderer.
//
// Lanes are the card's named streams (one per agent session, say). Lane 0 is all of them, live; then
// each lane in the host's order. The lane on screen is kept by NAME per card, so a lane the host adds
// does not shift what the human was reading, and coming back to the tab finds it where it was left.
//
// Actions are the host's keys. The board's own keys on a card's tab come first and cannot be taken,
// and `x` is reserved for the host's `stop` action, as it stops the copilot's turn on its transcript.
// An action with `input` opens the board's prompt (prompt.ts) and sends what was typed.
import type { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { type CardAction, STOP_ACTION } from "./ports";
import { BoardPrompt } from "./prompt";
import type { BoardTabs } from "./tabs";

export namespace CardTab {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	const NOTHING: BoardNav.Effect = { type: "none" };
	const UNREAD: BoardTabs.CardView = { lane: null, expanded: false };

	// Keys the board answers on a card's tab, whatever a host binds: an action under one is never
	// offered. `x` is the stop action's alone.
	const RESERVED: ReadonlySet<string> = new Set([
		..."xhlewoqjk{}!?A:O0123456789",
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

	/** The lanes an action aimed at a lane can go to from the tab: the one on screen, else the live ones. */
	const aimsOf = (tabs: BoardTabs.Tabs, id: string): readonly string[] => {
		const { lane } = view(tabs, id);
		if (lane !== null) return [lane];
		return tabs.cards.get(id)?.liveLanes ?? lanesOf(tabs, id);
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
				`${action.label} goes to one of the ${noun} · h/l picks it`,
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

	/** The card's own keys on its tab. Null for the keys the event view under it answers (j/k). */
	export const reduceKey = (
		state: State,
		id: string,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (key.ctrl || key.meta) return null;
		// A letter by what it types: OpenTUI names `X` as `x` with shift, which is not stop. A named
		// key (`left`, `return`) by its name, its sequence being an escape code.
		switch (key.name.length === 1 ? keyOf(key) : key.name) {
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
	): { lanes: boolean; stoppable: boolean } => {
		const id = state.tabs.active;
		if (id === null || state.view.type !== "events")
			return { lanes: false, stoppable: false };
		return {
			lanes: lanesOf(state.tabs, id).length > 0,
			stoppable:
				!state.tabs.cards.get(id)?.finished &&
				actionsOf(state.tabs, id).some((a) => a.id === STOP_ACTION),
		};
	};
}
