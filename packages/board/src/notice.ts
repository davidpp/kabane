// The footer's transient flash. Never silent: copies, state moves, review and cancel all surface a
// notice, failures the error and successes a confirmation.
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { BoardNav } from "./nav";

// How long the flash stays before clearing.
const NOTICE_MS = 1500;
// Undoable mutations hold their flash longer so the ⌃z hint has time to register.
const UNDO_HINT_MS = 4000;

/**
 * The flash on screen, cleared after NOTICE_MS (UNDO_HINT_MS for an undoable one). A set always makes
 * a fresh object, so a repeat copy restarts the timer.
 */
export const useNotice = (): [
	BoardNav.Notice | null,
	Dispatch<SetStateAction<BoardNav.Notice | null>>,
] => {
	const [notice, setNotice] = useState<BoardNav.Notice | null>(null);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(
			() => setNotice(null),
			notice.undoable ? UNDO_HINT_MS : NOTICE_MS,
		);
		return () => clearTimeout(timer);
	}, [notice]);
	return [notice, setNotice];
};

/**
 * A mutation's outcome as the flash: the reducer's composed text on success, the raw error message on
 * failure. Structural on Result<T> so it works for every BoardData mutation.
 */
export const flash = (
	res: { ok: true } | { ok: false; error: { message: string } },
	text: string,
): BoardNav.Notice =>
	res.ok
		? { text, tone: "success" }
		: { text: res.error.message, tone: "error" };
