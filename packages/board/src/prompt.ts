// A prompt the board opens for the human to type into, away from the copilot: the text a card's
// action takes (`inject` on a loop's tab) or the answer to a question that offers none to pick. It is
// the copilot's own input (prompt-field.tsx), so paste, multi-line text and `up` for what was sent
// before work the same, and while it is open it has the keyboard the way the copilot does when
// focused. Plain functions over the board's state, like every other key router.
//
// The textarea owns the buffer; `text` mirrors it so the reducer can tell an empty buffer (where
// `up` recalls) from one being edited. `enter` is the textarea's own submit binding and arrives
// through `submit`, not through the key router.
import type { BoardNav } from "./nav";
import { PromptHistory } from "./prompt-history";

export namespace BoardPrompt {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	/** What the text is for: a card's action, aimed at a lane or not, or a question's answer. */
	type Target =
		| { type: "act"; cardId: string; actionId: string; lane?: string }
		| { type: "answer"; questionId: string };

	/** What the panel says it is for (`inject → claude:JREP-2`) and what the empty field invites. */
	type Open = {
		target: Target;
		title: string;
		aim?: string;
		placeholder: string;
	};

	export type Prompt = {
		open: Open | null;
		text: string;
		// What was sent from it this session, and how far back `up` has walked (PromptHistory).
		history: readonly string[];
		historyAt: number;
	};

	export const CLOSED: Prompt = {
		open: null,
		text: "",
		history: [],
		historyAt: 0,
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	const withPrompt = (state: State, prompt: Partial<Prompt>): State => ({
		...state,
		prompt: { ...state.prompt, ...prompt },
	});

	/** Open the prompt, empty, with the keyboard: the copilot's pane folds back to its row. */
	export const open = (state: State, opened: Open): Step => ({
		state: {
			...withPrompt(state, { open: opened, text: "", historyAt: 0 }),
			focus: "board",
		},
		effect: NOTHING,
	});

	/** Drop it, typed text and all: `esc`, or a click elsewhere on the board. */
	export const close = (state: State): State =>
		state.prompt.open === null
			? state
			: withPrompt(state, { open: null, text: "", historyAt: 0 });

	const recalls = (state: State): boolean =>
		state.prompt.text === "" && state.prompt.history.length > 0;

	/**
	 * The keys app.tsx takes from the textarea while the prompt is open, as for the copilot: `esc`
	 * and `tab` always, `up`/`down` on an empty buffer with something to recall.
	 */
	export const consumes = (state: State, key: BoardNav.KeyInput): boolean => {
		if (state.prompt.open === null) return false;
		if (key.name === "escape" || key.name === "tab") return true;
		return (key.name === "up" || key.name === "down") && recalls(state);
	};

	const recall = (state: State, delta: 1 | -1): Step => {
		const { text, at } = PromptHistory.step(
			state.prompt.history,
			state.prompt.historyAt,
			delta,
		);
		return {
			state: withPrompt(state, { text, historyAt: at }),
			effect: { type: "promptSetText", text },
		};
	};

	/** The keys the prompt answers; every other one is the textarea's and does nothing here. */
	export const reduceKey = (state: State, key: BoardNav.KeyInput): Step => {
		if (key.name === "escape") return { state: close(state), effect: NOTHING };
		if (!consumes(state, key) || key.name === "tab")
			return { state, effect: NOTHING };
		return recall(state, key.name === "up" ? 1 : -1);
	};

	/** The textarea's submit: what was typed goes where the prompt was opened for. Empty sends nothing. */
	export const submit = (state: State, text: string): Step => {
		const opened = state.prompt.open;
		if (opened === null || text.trim() === "")
			return { state, effect: NOTHING };
		const { target } = opened;
		const sent = withPrompt(state, {
			open: null,
			text: "",
			historyAt: 0,
			history: PromptHistory.push(state.prompt.history, text),
		});
		return target.type === "answer"
			? {
					state: sent,
					effect: {
						type: "answerQuestion",
						questionId: target.questionId,
						answer: text,
					},
				}
			: {
					state: sent,
					effect: {
						type: "act",
						cardId: target.cardId,
						actionId: target.actionId,
						text,
						...(target.lane ? { lane: target.lane } : {}),
					},
				};
	};

	/** What app.tsx mirrors in as the human types. */
	export const withText = (state: State, text: string): State =>
		state.prompt.text === text ? state : withPrompt(state, { text });
}
