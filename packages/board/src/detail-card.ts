// The actions of a card that has no tab, run from its task's detail. A card with a tab is acted on
// there (card-tab.ts); one without, such as a recipe run that hc shows, has only its task's detail,
// so the detail lends it keys.
//
// The detail's own keys come first and cannot be taken. `x` cancels the task there, so the card's
// `stop` action is `X`, reserved for it as `x` is on a card's tab: with nothing to stop it does
// nothing, and never falls through to cancelling the task. An action aimed at a lane is not offered:
// the detail has no lane to aim it at, and `h/l` walk its sections.
import type { CardAction, StopAction } from "@kabane/extension";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { BoardPrompt } from "./prompt";
import type { BoardTabs } from "./tabs";

const STOP_ACTION: StopAction = "stop";

export namespace DetailCard {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };
	type Card = { id: string; card: BoardTabs.TabCard };

	/** The key that runs the card's `stop` action on the detail. */
	const STOP_KEY = "X";

	// Keys the detail answers, the everywhere keys among them, whatever a host binds: read from the
	// registry, whose drift guard holds it to nav.ts. Its answer row lists two digits for `1-9`; a
	// question takes all nine.
	const RESERVED: ReadonlySet<string> = new Set([
		...[...Keymap.CONTEXTS.detail.bindings, ...Keymap.EVERYWHERE].flatMap(
			(binding) => binding.keys,
		),
		..."123456789",
	]);

	/**
	 * The open task's cards without a tab that offer actions, the newest first. Whether the run is in
	 * flight is the host's call: it offers `stop` while there is something to stop, idle runs included,
	 * which report `completed` yet still sit open.
	 */
	const cardsOf = (state: State): Card[] => {
		if (state.view.type !== "detail") return [];
		const { taskId } = state.view;
		const shortId = BoardNav.taskById(state, taskId)?.shortId;
		return [...state.tabs.loose]
			.filter(
				([, card]) =>
					card.taskId === taskId ||
					(shortId !== undefined && card.taskShortId === shortId),
			)
			.map(([id, card]) => ({ id, card }));
	};

	const actionsOf = (card: BoardTabs.TabCard): readonly CardAction[] =>
		(card.actions ?? []).filter(
			(action) =>
				!action.lane &&
				(action.id === STOP_ACTION || !RESERVED.has(action.key)),
		);

	const stopOf = (card: BoardTabs.TabCard): CardAction | undefined =>
		actionsOf(card).find((action) => action.id === STOP_ACTION);

	const othersOf = (card: BoardTabs.TabCard): readonly CardAction[] =>
		actionsOf(card).filter((action) => action.id !== STOP_ACTION);

	/** The newest card `X` stops, with its stop. */
	const stopping = (
		state: State,
	): { id: string; card: BoardTabs.TabCard; stop: CardAction } | undefined => {
		for (const { id, card } of cardsOf(state)) {
			const stop = stopOf(card);
			if (stop) return { id, card, stop };
		}
		return undefined;
	};

	/** The newest card that offers an action other than `stop`: the one whose keys the detail lends. */
	const acting = (state: State): Card | undefined =>
		cardsOf(state).find(({ card }) => othersOf(card).length > 0);

	const run = (state: State, id: string, action: CardAction): Step =>
		action.input === undefined
			? { state, effect: { type: "act", cardId: id, actionId: action.id } }
			: BoardPrompt.open(state, {
					target: { type: "act", cardId: id, actionId: action.id },
					title: action.label,
					placeholder: action.input,
				});

	/**
	 * The card's keys on the detail: `X` stops it, its other actions under their own key. Null for every
	 * other key, which the detail answers.
	 */
	export const reduceKey = (
		state: State,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (key.ctrl || key.meta || state.view.type !== "detail") return null;
		// OpenTUI names `X` as `x` with shift; some terminals send the letter itself.
		const typed =
			key.sequence ?? (key.shift ? key.name.toUpperCase() : key.name);
		if (typed === STOP_KEY) {
			const found = stopping(state);
			return found
				? run(state, found.id, found.stop)
				: { state, effect: { type: "none" } };
		}
		const found = acting(state);
		const action = found && othersOf(found.card).find((a) => a.key === typed);
		return found && action ? run(state, found.id, action) : null;
	};

	/** What the detail's `X` hint names: the label of the card it stops, while there is one. */
	export const stoppable = (state: State): string | undefined =>
		stopping(state)?.card.label;

	/**
	 * The footer's hints for the card's own actions, `stop` left to the registry's `X`. Only while the
	 * detail has the keys: under an open prompt or a decision's text they would be typed.
	 */
	export const hints = (state: State): Keymap.Hint[] => {
		if (BoardNav.keyContext(state) !== "detail") return [];
		const found = acting(state);
		return found
			? othersOf(found.card).map((action) => ({
					key: action.key,
					label: action.label,
				}))
			: [];
	};
}
