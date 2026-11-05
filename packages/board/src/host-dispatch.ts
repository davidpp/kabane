// Handing a task to the host's Dispatcher: the triggers it can start on the task, listed into the
// dispatch overlay, and the one the human confirms. Never silent — success flashes the host's notice,
// failure the error message.
import { useCallback } from "react";
import type { BoardStore } from "./board-store";
import { BoardData } from "./data";
import { BoardNav } from "./nav";
import { reported, type SetNotice } from "./notice";
import type { Copilot, Dispatcher } from "./ports";

const DISPATCH_EFFECTS = ["loadTriggers", "dispatch"] as const;
export type DispatchEffect = Extract<
	BoardNav.Effect,
	{ type: (typeof DISPATCH_EFFECTS)[number] }
>;
export const isDispatchEffect = BoardNav.effectsOf(DISPATCH_EFFECTS);

// Without a dispatcher no extension is on. A copilot that can set kabane up is the way to turn one
// on without knowing the config's keys.
const noDispatcher = (copilot: Copilot | undefined): BoardNav.Notice => ({
	text: copilot?.shortcuts().some((s) => s.name === "setup")
		? "no extension dispatches here · /setup in the copilot turns on the loop"
		: "no dispatcher configured",
	tone: "error",
});

/** The runner for the dispatch effects; `next` is the state the dispatch was confirmed in. */
export const useHostDispatch = ({
	basePath,
	dispatcher,
	copilot,
	store: { ref, update },
	setNotice,
	reload,
}: {
	basePath: string;
	dispatcher: Dispatcher | undefined;
	// Only for what the footer says when there is no dispatcher.
	copilot: Copilot | undefined;
	store: Pick<BoardStore, "ref" | "update">;
	setNotice: SetNotice;
	// After a dispatch, so a newly started card shows up.
	reload: (s: BoardNav.BoardState) => Promise<void>;
}): ((next: BoardNav.BoardState, effect: DispatchEffect) => void) => {
	// Ask the host what it can start on this task; merge the answer into the open overlay. Without a
	// dispatcher the overlay closes and the footer says so — never silent.
	const loadTriggers = useCallback(
		async (taskId: string): Promise<void> => {
			if (!dispatcher) {
				update((prev) => ({ ...prev, dispatch: null }));
				setNotice(noDispatcher(copilot));
				return;
			}
			const result = await dispatcher.triggers(taskId);
			if (!result.ok) {
				update((prev) => ({ ...prev, dispatch: null }));
				setNotice({ text: result.error.message, tone: "error" });
				return;
			}
			update((prev) => BoardNav.withTriggers(prev, result.value));
		},
		[dispatcher, copilot, update, setNotice],
	);

	// Run a confirmed dispatch: assemble the brief, hand the host the target, and flash the outcome.
	const dispatch = useCallback(
		async (
			s: BoardNav.BoardState,
			{ triggerId, id, inputs }: Extract<DispatchEffect, { type: "dispatch" }>,
		): Promise<void> => {
			if (!dispatcher) {
				setNotice(noDispatcher(copilot));
				return;
			}
			const task = BoardNav.taskById(s, id);
			const shortId = BoardNav.shortIdOf(task, id);
			const brief = await BoardData.taskBrief(basePath, id);
			if (!brief.ok) {
				setNotice({ text: brief.error.message, tone: "error" });
				return;
			}
			const res = await dispatcher.dispatch(
				triggerId,
				{ id, shortId, title: task?.title ?? "", brief: brief.value },
				inputs,
			);
			setNotice(reported(res));
			// Refresh activity so a newly started card shows up.
			const current = ref.current;
			if (current) void reload(current);
		},
		[dispatcher, copilot, basePath, reload, ref, setNotice],
	);

	return useCallback(
		(next: BoardNav.BoardState, effect: DispatchEffect): void => {
			if (effect.type === "loadTriggers") void loadTriggers(effect.taskId);
			else void dispatch(next, effect);
		},
		[loadTriggers, dispatch],
	);
};
