// This session's copilot turns, one at a time: the log they stream into (the current turn at its
// head: its card, its plan and its transcript), and what each update does to the board.
import type { RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { BoardStore } from "./board-store";
import { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import type { BoardData } from "./data";
import { BoardNav } from "./nav";
import type { SetNotice } from "./notice";
import type { Copilot, CopilotUpdate } from "./ports";

export const NO_COPILOT: BoardNav.Notice = {
	text: "no copilot configured",
	tone: "error",
};

export type CopilotSession = {
	log: CopilotLog.Log | null;
	// The log as the stream last wrote it, which it does between renders.
	current: () => CopilotLog.Log | null;
	// One turn on `prompt`, with the context `s` holds.
	run: (s: BoardNav.BoardState, prompt: string) => Promise<void>;
	// Stop the turn in flight.
	cancel: () => void;
};

const errorMessage = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

const now = (): string => new Date().toISOString();

export const useCopilotSession = ({
	copilot,
	basePath,
	store: { ref, update },
	scopeRef,
	reload,
	setNotice,
}: {
	copilot: Copilot | undefined;
	basePath: string;
	store: Pick<BoardStore, "ref" | "update">;
	scopeRef: RefObject<BoardData.ScopeInfo | null>;
	// After each completed write the turn makes.
	reload: (s: BoardNav.BoardState) => Promise<void>;
	setNotice: SetNotice;
}): CopilotSession => {
	// Held in a ref as well, because the composed ActivitySource reads it while the event view polls,
	// and the stream writes it between renders.
	const [log, setLog] = useState<CopilotLog.Log | null>(null);
	const logRef = useRef<CopilotLog.Log | null>(null);
	const publish = useCallback(
		(next: CopilotLog.Log): void => {
			logRef.current = next;
			setLog(next);
			// The reducer holds no log, but `o` routes on whether one exists — so it gets the one bit.
			update((prev) => BoardNav.withCopilotLog(prev, true));
		},
		[update],
	);
	const current = useCallback((): CopilotLog.Log | null => logRef.current, []);
	// Which turn the stream is on; a cancel or a new prompt moves it so a stale stream's late updates
	// are dropped rather than written over the next turn's log.
	const turnRef = useRef(0);
	const endTurn = useCallback(
		(turn: BoardNav.CopilotTurn): void =>
			update((prev) => BoardNav.withCopilotTurn(prev, turn)),
		[update],
	);

	// What an update does beyond the log.
	const take = useCallback(
		(step: CopilotUpdate): void => {
			switch (step.type) {
				// The harness is blocked from here until the human presses something; the board only
				// puts the question on screen and carries on rendering.
				case "permission":
					update((prev) => BoardNav.withCopilotPermission(prev, step.request));
					return;
				case "elicitation":
					update((prev) => BoardNav.withCopilotElicitation(prev, step.request));
					return;
				// Taken back unanswered: the block goes, and when it was the one on screen the footer
				// says why it went. A key already on its way answers nothing, since the copilot no longer
				// holds the request.
				case "withdrawn":
					if (ref.current?.copilot.asks[0]?.request.id === step.id)
						setNotice({ text: step.summary, tone: "error" });
					update((prev) => BoardNav.withCopilotWithdrawn(prev, step.id));
					return;
				case "commands":
					update((prev) =>
						BoardNav.withCopilotCommands(prev, step.source, step.commands),
					);
					return;
				case "tool_result":
					if (step.wrote && ref.current) void reload(ref.current);
					return;
				case "done":
				case "error":
					endTurn(step.type);
			}
		},
		[ref, update, setNotice, reload, endTurn],
	);

	// One copilot turn: assemble the context, stream the run into the log, and hand the reducer the
	// turn's end. The stream is the one place the port can throw at us (an AsyncIterable has no
	// Result), so the boundary catches and ends the turn as an error rather than letting it reach
	// React.
	const run = useCallback(
		async (s: BoardNav.BoardState, prompt: string): Promise<void> => {
			if (!copilot) {
				setNotice(NO_COPILOT);
				endTurn("idle");
				return;
			}
			const turn = ++turnRef.current;
			// Behind this turn, the ones before it: the prompt is what opens a new one in the log.
			let next = CopilotLog.start(logRef.current, prompt, now());
			publish(next);
			const fail = (summary: string): void => {
				next = CopilotLog.apply(next, { type: "error", summary, at: now() });
				publish(next);
				endTurn("error");
			};
			const context = await BoardContext.load(basePath, s, scopeRef.current);
			if (turnRef.current !== turn) return;
			if (!context.ok) {
				fail(context.error.message);
				return;
			}
			try {
				for await (const step of copilot.run(prompt, context.value)) {
					if (turnRef.current !== turn) return;
					next = CopilotLog.apply(next, step);
					publish(next);
					take(step);
				}
				// A stream that ends without saying so still ended.
				if (next.current.card.status === "running") {
					next = CopilotLog.apply(next, {
						type: "done",
						summary: "",
						at: now(),
					});
					publish(next);
					endTurn("done");
				}
			} catch (e) {
				if (turnRef.current === turn) fail(errorMessage(e));
			}
		},
		[copilot, basePath, scopeRef, publish, take, endTurn, setNotice],
	);

	// Tell the copilot, drop its remaining updates, close the card.
	const cancel = useCallback((): void => {
		turnRef.current++;
		void copilot?.cancel();
		const last = logRef.current;
		if (last && last.current.card.status === "running")
			publish(CopilotLog.cancelled(last, now()));
		endTurn("error");
	}, [copilot, publish, endTurn]);

	return { log, current, run, cancel };
};
