// The reducer's state as the board holds it, for every part of the board that writes to it: null
// until the first load, and mirrored in a ref for the key, mouse and poll callbacks, which capture
// once but must read the latest. `set` writes the ref as soon as it is called, so keys that land
// between renders (a paste into the prompt or the search box) each see the previous key's result.
import { type RefObject, useCallback, useRef, useState } from "react";
import type { BoardNav } from "./nav";

export type BoardStore = {
	state: BoardNav.BoardState | null;
	ref: RefObject<BoardNav.BoardState | null>;
	// A whole state at once: the first load, or what a key or a click reduced to.
	set: (next: BoardNav.BoardState) => void;
	// One step on the state in hand, which nothing takes before the first load.
	update: (step: (prev: BoardNav.BoardState) => BoardNav.BoardState) => void;
};

export const useBoardStore = (): BoardStore => {
	const [state, setState] = useState<BoardNav.BoardState | null>(null);
	const ref = useRef<BoardNav.BoardState | null>(null);
	ref.current = state;
	const set = useCallback((next: BoardNav.BoardState): void => {
		ref.current = next;
		setState(next);
	}, []);
	const update = useCallback(
		(step: (prev: BoardNav.BoardState) => BoardNav.BoardState): void =>
			setState((prev) => (prev ? step(prev) : prev)),
		[],
	);
	return { state, ref, set, update };
};
