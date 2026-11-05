// The work running on the board's tasks, as every surface that lists it sees it: the host's cards
// plus the copilot's own, the questions they wait on, and what the human does to them (answers a
// question, runs a card's action, closes its tab, opens its events).
import { useCallback, useEffect, useMemo, useRef } from "react";
import { BoardActivity } from "./activity";
import type { BoardStore } from "./board-store";
import { CopilotLog } from "./copilot-log";
import { BoardData } from "./data";
import { BoardNav } from "./nav";
import { flash, type SetNotice } from "./notice";
import type { ActivityCard, ActivitySource } from "./ports";
import { BoardTabs } from "./tabs";

export type RunActivity = {
	// Host cards plus the copilot's, for every surface that lists activity.
	shown: BoardActivity.ActivityMap;
	// The host's source with the copilot's card composed in.
	source: ActivitySource;
	answer: (
		s: BoardNav.BoardState,
		questionId: string,
		text: string,
	) => Promise<void>;
	dismiss: (cardId: string) => Promise<void>;
	act: (
		s: BoardNav.BoardState,
		effect: Extract<BoardNav.Effect, { type: "act" }>,
	) => Promise<void>;
	openEvents: (s: BoardNav.BoardState, taskId: string) => void;
	// The event view on a card's tab refreshes its card every second; the keys read the same card.
	takeCard: (card: ActivityCard) => void;
};

export const useRunActivity = ({
	basePath,
	activity,
	activitySource,
	copilotLog,
	currentLog,
	store: { set, update },
	setNotice,
	reload,
}: {
	basePath: string;
	// The host's, as the board's feed last read it.
	activity: BoardActivity.ActivityMap;
	activitySource: ActivitySource;
	copilotLog: CopilotLog.Log | null;
	currentLog: () => CopilotLog.Log | null;
	store: Pick<BoardStore, "set" | "update">;
	setNotice: SetNotice;
	// After a write, so the badges and the tabs show it.
	reload: (s: BoardNav.BoardState) => Promise<void>;
}): RunActivity => {
	const shown = useMemo(
		() => CopilotLog.withActivity(activity, copilotLog),
		[activity, copilotLog],
	);
	const shownRef = useRef<BoardActivity.ActivityMap>(shown);
	shownRef.current = shown;
	const source = useMemo(
		() => CopilotLog.source(activitySource, currentLog),
		[activitySource, currentLog],
	);

	// The tab bar follows the cards that ask for a tab, and the attention queue follows the tracker's
	// unanswered questions, both on every activity load.
	useEffect(() => {
		update((prev) =>
			BoardTabs.withActivity(prev, shown.cards, BoardActivity.questions(shown)),
		);
	}, [shown, update]);

	// `o` in the detail view: the task's card with events (BoardActivity.eventsCard). A card with a tab
	// of its own opens as that tab, so one card never shows in two places.
	const openEvents = useCallback(
		(s: BoardNav.BoardState, taskId: string): void => {
			const target = BoardActivity.eventsCard(
				shownRef.current,
				taskId,
				BoardNav.taskById(s, taskId)?.shortId,
			);
			if (!target) {
				setNotice({ text: "no events", tone: "success" });
				return;
			}
			if (s.tabs.open.includes(target.id)) {
				set(BoardTabs.reduceMouse(s, { type: "tab", id: target.id }).state);
				return;
			}
			set({
				...s,
				view: {
					type: "events",
					cardId: target.id,
					fromView: "detail",
					fromTaskId: taskId,
					fromTab: BoardNav.detailTab(s.view),
				},
			});
		},
		[setNotice, set],
	);

	// A banner's question answered: core writes the decision, the banner says what was answered until
	// the human leaves, and the reload takes the question off every badge. The host hears it first, so
	// one that keeps who answered has it before its work sees the answer; a failed note does not hold
	// the answer back. A failed write takes back the answer the digit set on the banner.
	const answer = useCallback(
		async (
			s: BoardNav.BoardState,
			questionId: string,
			text: string,
		): Promise<void> => {
			await source.answering?.(questionId);
			const res = await BoardData.answerQuestion(basePath, questionId, text);
			setNotice(flash(res, `answered ${text}`));
			update((prev) =>
				(res.ok ? BoardTabs.withAnswered : BoardTabs.withoutAnswer)(
					prev,
					questionId,
					text,
				),
			);
			await reload(s);
		},
		[basePath, reload, source, update, setNotice],
	);

	// `w` closed a finished card's tab: the host forgets it, so a relaunch does not bring it back. The
	// tab is already gone either way; only a failure has anything to say.
	const dismiss = useCallback(
		async (cardId: string): Promise<void> => {
			const res = await source.dismiss?.(cardId);
			if (res && !res.ok) setNotice({ text: res.error.message, tone: "error" });
		},
		[source, setNotice],
	);

	// One of a card's actions: the host runs it and says what happened, and the reload shows it.
	const act = useCallback(
		async (
			s: BoardNav.BoardState,
			effect: Extract<BoardNav.Effect, { type: "act" }>,
		): Promise<void> => {
			const { cardId, actionId, text, lane } = effect;
			const res = source.act
				? await source.act(cardId, actionId, {
						...(text !== undefined ? { text } : {}),
						...(lane !== undefined ? { lane } : {}),
					})
				: null;
			setNotice(
				res === null
					? { text: "this card takes no actions", tone: "error" }
					: res.ok
						? { text: res.value, tone: "success" }
						: { text: res.error.message, tone: "error" },
			);
			await reload(s);
		},
		[source, reload, setNotice],
	);

	const takeCard = useCallback(
		(card: ActivityCard): void =>
			update((prev) => BoardTabs.withCard(prev, card)),
		[update],
	);

	return { shown, source, answer, dismiss, act, openEvents, takeCard };
};
