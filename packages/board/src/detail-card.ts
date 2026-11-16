// The actions of a card that has no tab, run from its task's detail. A card with a tab is acted on
// there (card-tab.ts); one without, such as a recipe run that hc shows, has only its task's detail,
// so the detail lends it keys.
//
// The detail's own keys come first and cannot be taken. `x` cancels the task there, so the card's
// `stop` action is `X`, reserved for it as `x` is on a card's tab: with nothing to stop it does
// nothing, and never falls through to cancelling the task. An action aimed at a lane is not offered:
// the detail has no lane to aim it at, and `h/l` walk its sections.
import type { CardAction, StopAction } from "@cabane/extension";
import type { Keymap } from "./keymap";
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

	// Keys the detail answers, the everywhere keys among them, whatever a host binds.
	const RESERVED: ReadonlySet<string> = new Set([
		..."hljkgGJKrovymansxXbqOdu?!{},A:0123456789",
		"space",
		"escape",
		"return",
		"enter",
		"tab",
		"up",
		"down",
		"left",
		"right",
	]);

	/** The open task's in-flight card without a tab that offers actions, the newest first. */
	const cardOf = (state: State): Card | undefined => {
		if (state.view.type !== "detail") return undefined;
		const { taskId } = state.view;
		const shortId = BoardNav.taskById(state, taskId)?.shortId;
		for (const [id, card] of state.tabs.loose) {
			const ours =
				card.taskId === taskId ||
				(shortId !== undefined && card.taskShortId === shortId);
			if (ours && !card.finished) return { id, card };
		}
		return undefined;
	};

	const actionsOf = (card: BoardTabs.TabCard): readonly CardAction[] =>
		(card.actions ?? []).filter(
			(action) =>
				!action.lane &&
				(action.id === STOP_ACTION || !RESERVED.has(action.key)),
		);

	const stopOf = (card: BoardTabs.TabCard): CardAction | undefined =>
		actionsOf(card).find((action) => action.id === STOP_ACTION);

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
		const found = cardOf(state);
		if (typed === STOP_KEY) {
			const stop = found && stopOf(found.card);
			return found && stop
				? run(state, found.id, stop)
				: { state, effect: { type: "none" } };
		}
		if (!found) return null;
		const action = actionsOf(found.card).find(
			(a) => a.id !== STOP_ACTION && a.key === typed,
		);
		return action ? run(state, found.id, action) : null;
	};

	/** What the detail's `X` hint names: the label of the card it stops, while there is one. */
	export const stoppable = (state: State): string | undefined => {
		const found = cardOf(state);
		return found && stopOf(found.card) ? found.card.label : undefined;
	};

	/**
	 * The footer's hints for the card's own actions, `stop` left to the registry's `X`. Only while the
	 * detail has the keys: under an open prompt or a decision's text they would be typed.
	 */
	export const hints = (state: State): Keymap.Hint[] => {
		if (BoardNav.keyContext(state) !== "detail") return [];
		const found = cardOf(state);
		return found
			? actionsOf(found.card)
					.filter((action) => action.id !== STOP_ACTION)
					.map((action) => ({ key: action.key, label: action.label }))
			: [];
	};
}
