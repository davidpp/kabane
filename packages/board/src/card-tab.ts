// A host card's own tab, past what the tab bar decides (tabs.ts): which of its lanes is on screen.
// Plain functions over the board's state, like the rest of the key routing, so the keys and the
// mouse are tested without a renderer.
//
// Lanes are the card's named streams (one per agent session, say). Lane 0 is all of them, live; then
// each lane in the host's order. The lane on screen is kept by NAME per card, so a lane the host adds
// does not shift what the human was reading, and coming back to the tab finds it where it was left.
import type { BoardNav } from "./nav";
import type { BoardTabs } from "./tabs";

export namespace CardTab {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	const NOTHING: BoardNav.Effect = { type: "none" };
	const UNREAD: BoardTabs.CardView = { lane: null };

	/** How the card's tab is being read: its lane on screen. */
	export const view = (tabs: BoardTabs.Tabs, id: string): BoardTabs.CardView =>
		tabs.views.get(id) ?? UNREAD;

	const lanesOf = (tabs: BoardTabs.Tabs, id: string): readonly string[] =>
		tabs.cards.get(id)?.lanes ?? [];

	/** The lane on screen as a chip index: 0 for every lane, else its place in the host's list + 1. */
	export const laneIndex = (tabs: BoardTabs.Tabs, id: string): number => {
		const { lane } = view(tabs, id);
		return lane === null ? 0 : lanesOf(tabs, id).indexOf(lane) + 1;
	};

	const withLane = (state: State, id: string, index: number): State => {
		const lane = lanesOf(state.tabs, id)[index - 1] ?? null;
		if (lane === view(state.tabs, id).lane) return state;
		const views = new Map(state.tabs.views).set(id, {
			...view(state.tabs, id),
			lane,
		});
		return { ...state, tabs: { ...state.tabs, views } };
	};

	// `h`/`l`: the previous or next lane, every lane included, wrapping both ways.
	const stepLane = (state: State, id: string, delta: 1 | -1): Step | null => {
		const count = lanesOf(state.tabs, id).length + 1;
		if (count === 1) return null;
		const at = (laneIndex(state.tabs, id) + delta + count) % count;
		return { state: withLane(state, id, at), effect: NOTHING };
	};

	/** The card's own keys on its tab. Null for the keys the event view under it answers (j/k). */
	export const reduceKey = (
		state: State,
		id: string,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (key.ctrl || key.meta) return null;
		switch (key.name) {
			case "h":
			case "left":
				return stepLane(state, id, -1);
			case "l":
			case "right":
				return stepLane(state, id, 1);
			default:
				return null;
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

	/** Facts the footer's `when`s read, about the card on screen. */
	export const situation = (state: State): { lanes: boolean } => {
		const id = state.tabs.active;
		return { lanes: id !== null && lanesOf(state.tabs, id).length > 0 };
	};
}
