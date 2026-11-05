// Every key, click and textarea submit, routed through the pure reducers (BoardNav.reduceKey and
// reduceMouse, the copilot's and the form's submits, BoardPrompt.submit), with the effect each returns
// handed to the one runner app.tsx composes, so every interaction path executes the reducer's output
// the same way. The board has ONE useKeyboard handler, and this is it.
import { useKeyboard, useRenderer } from "@opentui/react";
import { useCallback } from "react";
import type { BoardStore } from "./board-store";
import { BoardNav } from "./nav";
import { BoardPrompt } from "./prompt";
import type { ScreenRefs } from "./screen";

type Reduced = { state: BoardNav.BoardState; effect: BoardNav.Effect };

export type BoardInput = {
	// Routes a board mouse action through the same pure reducer as keys. Keeps selection
	// single-sourced: the mouse handlers never write the state with an ad-hoc coordinate.
	dispatchMouse: (action: BoardNav.MouseAction) => void;
	// The copilot textarea's own `submit` binding (enter). The reducer decides expand-versus-send so
	// the `/name` rule lives in one place.
	submitCopilot: () => void;
	// `enter` in a form's input: the reducer reads the field and moves the form on, or sends it.
	submitForm: (text: string) => void;
	// Mirror the buffer into the reducer so `/` matching sees what the human sees.
	mirrorCopilotText: () => void;
	// The same two for a prompt a card's tab or a banner opened.
	submitPrompt: () => void;
	mirrorPromptText: () => void;
};

export const useBoardInput = ({
	store: { ref, set, update },
	clock,
	error,
	retry,
	runEffect,
	refs: { input: inputRef, prompt: promptRef },
}: {
	store: Pick<BoardStore, "ref" | "set" | "update">;
	clock: () => number;
	// The first load failed: the keys are the error screen's.
	error: string | null;
	retry: () => void;
	runEffect: (next: BoardNav.BoardState, effect: BoardNav.Effect) => void;
	// The copilot's input, and the same input opened as a prompt. Each OWNS its text, read here on
	// submit and mirrored on every change.
	refs: Pick<ScreenRefs, "input" | "prompt">;
}): BoardInput => {
	const renderer = useRenderer();

	// Reduce the state in hand and run what the reducer asks for. The new state is written before
	// the effect runs, so keys that land between renders each see the previous key's result.
	const commit = useCallback(
		(reduce: (current: BoardNav.BoardState) => Reduced): void => {
			const current = ref.current;
			if (!current) return;
			const { state: next, effect } = reduce(current);
			if (next !== current) set(next);
			runEffect(next, effect);
		},
		[ref, set, runEffect],
	);

	useKeyboard((key) => {
		// Error screen: `r` retries the initial load, `q` quits.
		if (error) {
			if (key.name === "r") retry();
			else if (key.name === "q") renderer.destroy();
			return;
		}
		const current = ref.current;
		if (!current) {
			if (key.name === "q") renderer.destroy();
			return;
		}
		// A focused textarea sees every key as well, global handler first. Claiming the keys the
		// copilot reducer answers is what keeps `tab` and `esc` from also landing in the buffer.
		if (
			BoardNav.copilotConsumes(current, key) ||
			BoardPrompt.consumes(current, key)
		)
			key.preventDefault();
		commit((s) => BoardNav.reduceKey(s, key, clock()));
	});

	const dispatchMouse = useCallback(
		(action: BoardNav.MouseAction): void =>
			commit((s) => BoardNav.reduceMouse(s, action)),
		[commit],
	);
	const submitCopilot = useCallback(
		(): void =>
			commit((s) =>
				BoardNav.submitCopilot(s, inputRef.current?.plainText ?? ""),
			),
		[commit, inputRef],
	);
	const submitForm = useCallback(
		(text: string): void => commit((s) => BoardNav.submitForm(s, text)),
		[commit],
	);
	const mirrorCopilotText = useCallback((): void => {
		const text = inputRef.current?.plainText ?? "";
		update((prev) => BoardNav.withCopilotText(prev, text));
	}, [update, inputRef]);
	const submitPrompt = useCallback(
		(): void =>
			commit((s) => BoardPrompt.submit(s, promptRef.current?.plainText ?? "")),
		[commit, promptRef],
	);
	const mirrorPromptText = useCallback((): void => {
		const text = promptRef.current?.plainText ?? "";
		update((prev) => BoardPrompt.withText(prev, text));
	}, [update, promptRef]);

	return {
		dispatchMouse,
		submitCopilot,
		submitForm,
		mirrorCopilotText,
		submitPrompt,
		mirrorPromptText,
	};
};
