/** @jsxImportSource @opentui/react */
// Top-level board screen: loads planner data, holds board + selection state, and drives every
// interaction through ONE useKeyboard handler that delegates to BoardNav.reduceKey (the pure key
// router) and runs the effect it returns. A 5s poll keeps the board fresh; selection survives every
// reload by task id. The board starts scoped to the detected project — `esc` widens to all scopes.
import type { Result, Task } from "@cabane/core";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BoardActivity } from "./activity";
import { anyActivityRunning, Board } from "./board";
import { useBoardStore } from "./board-store";
import { CardTab } from "./card-tab";
import { Clipboard } from "./clipboard";
import { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { CopilotPane, contextChip } from "./copilot-prompt";
import { BoardData } from "./data";
import { Detail } from "./detail";
import { EventView } from "./event-view";
import { FooterTrail } from "./footer";
import { Launcher } from "./launcher";
import { BoardNav } from "./nav";
import { flash, useNotice } from "./notice";
import { HelpSheet } from "./overlay";
import type {
	ActivityCard,
	ActivitySource,
	CardHeader,
	Copilot,
	Dispatcher,
} from "./ports";
import { ProgramStatus } from "./program-status";
import { BoardPrompt } from "./prompt";
import { PromptPanel } from "./prompt-field";
import { useSpinnerFrame } from "./spinner";
import { CardTabQuestion, PinnedQuestion, TabBar } from "./tab-bar";
import { BoardTabs } from "./tabs";
import { useTheme } from "./theme";
import { DispatchLayer } from "./trigger-form-view";

export type AppProps = {
	cwd: string;
	// The storage handle the configured Db provider interprets (a directory for bun:sqlite).
	basePath: string;
	activity: ActivitySource;
	// Absent → `a` flashes "no dispatcher configured".
	dispatcher?: Dispatcher;
	// Absent → `A` flashes "no copilot configured".
	copilot?: Copilot;
	// Absent → the board opens on all scopes.
	resolveScope?: BoardData.ScopeResolver;
	// A host's own header for its cards, by card kind. Absent → every card tab heads with its title.
	headers?: Readonly<Record<string, CardHeader>>;
	// Milliseconds, for how long a question has been on screen before a digit answers it
	// (BoardNav.ARM_MS). Absent → Date.now.
	clock?: () => number;
};

const POLL_INTERVAL_MS = 5000;
// Stable identity so a board with nothing linked doesn't re-render on it.
const EMPTY_LINKS: ReadonlySet<string> = new Set<string>();

const shortIdOf = (task: Task | undefined, id: string): string =>
	task?.shortId ?? id.slice(0, 8);

const NO_COPILOT: BoardNav.Notice = {
	text: "no copilot configured",
	tone: "error",
};

// Without a dispatcher no extension is on. A copilot that can set kabane up is the way to turn one
// on without knowing the config's keys.
const noDispatcher = (copilot: Copilot | undefined): BoardNav.Notice => ({
	text: copilot?.shortcuts().some((s) => s.name === "setup")
		? "no extension dispatches here · /setup in the copilot turns on the loop"
		: "no dispatcher configured",
	tone: "error",
});

const errorMessage = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

export const App = ({
	cwd,
	basePath,
	activity: activitySource,
	dispatcher,
	copilot,
	resolveScope,
	headers,
	clock = Date.now,
}: AppProps): ReactNode => {
	const renderer = useRenderer();
	const theme = useTheme();
	const {
		state,
		ref: stateRef,
		set: setState,
		update: updateState,
	} = useBoardStore();
	const [scope, setScope] = useState<BoardData.ScopeInfo | null>(null);
	// In-flight host cards + awaiting-input questions, refreshed by the same poll as the board data. A
	// failed activity read keeps the previous map — the board is a glance surface, badges degrade quietly.
	const [activity, setActivity] = useState<BoardActivity.ActivityMap>(
		BoardActivity.emptyActivity(),
	);
	// Task ids pointing at an external issue, refreshed by the same poll. Degrades the same way the
	// activity map does: a failed read keeps the last-good set rather than un-glyphing every row.
	const [linked, setLinked] = useState<ReadonlySet<string>>(EMPTY_LINKS);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useNotice();
	// The records the open detail view shows (BoardData.taskDetail): null while none is open or it
	// loads, cleared on view change.
	const [detailRecords, setDetailRecords] =
		useState<Result<BoardData.DetailRecords> | null>(null);
	// Which task those records are for, and their stamp (BoardData.recordsStamp): the poll compares a
	// fresh stamp against it and reloads the records only when something landed.
	const detailLoadedId = useRef<string | null>(null);
	const detailStamp = useRef<string | null>(null);
	// This session's copilot turns, the current one at the head: its card, its plan and its transcript.
	// Held in a ref as well because the composed ActivitySource below reads it while the event view
	// polls, and the stream runner writes it between renders.
	const [copilotLog, setCopilotLog] = useState<CopilotLog.Log | null>(null);
	const copilotLogRef = useRef<CopilotLog.Log | null>(null);
	const publishLog = useCallback(
		(log: CopilotLog.Log): void => {
			copilotLogRef.current = log;
			setCopilotLog(log);
			// The reducer holds no log, but `o` routes on whether one exists — so it gets the one bit.
			updateState((prev) => BoardNav.withCopilotLog(prev, true));
		},
		[updateState],
	);
	// Which turn the stream runner is on; a cancel or a new prompt moves it so a stale stream's late
	// updates are dropped rather than written over the next turn's log.
	const turnRef = useRef(0);
	// Host cards plus the copilot's, for every surface that lists activity.
	const shownActivity = useMemo(
		() => CopilotLog.withActivity(activity, copilotLog),
		[activity, copilotLog],
	);
	const shownSource = useMemo(
		() => CopilotLog.source(activitySource, () => copilotLogRef.current),
		[activitySource],
	);

	// Refs mirror state for the keyboard/poll callbacks, which capture once but must read the latest.
	// The terminal hears when the board waits on the human, or works: derived from what the board
	// holds, and written only when it changes.
	const copilotAsks = state?.copilot.asks;
	const copilotTurn = state?.copilot.turn;
	const questionQueue = state?.tabs.queue;
	const programStatus = useMemo(
		() =>
			ProgramStatus.reports({
				copilot: { asks: copilotAsks ?? [], turn: copilotTurn ?? "idle" },
				questions: questionQueue ?? [],
				cards: activity.cards,
			}),
		[copilotAsks, copilotTurn, questionQueue, activity.cards],
	);
	ProgramStatus.useProgramStatus(programStatus);

	// Every committed state is on screen: note what the digits answer from now on, so a question
	// that just appeared does not take a key already on its way (BoardNav.sight).
	useEffect(() => {
		updateState((prev) => BoardNav.sight(prev, clock()));
	}, [state, clock, updateState]);
	const scopeRef = useRef<BoardData.ScopeInfo | null>(null);
	scopeRef.current = scope;
	const activityRef = useRef<BoardActivity.ActivityMap>(shownActivity);
	activityRef.current = shownActivity;
	// The detail view's scrollbox lives inside <Detail>; app.tsx holds the ref so the `scroll` effect
	// can drive it and every key stays in the one useKeyboard handler.
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	// The board list's scrollbox; app.tsx keeps the selected row in view as j/k move it off-screen.
	const listRef = useRef<ScrollBoxRenderable | null>(null);
	// The `?` sheet's scrollbox, which j/k move while it is open (`helpScroll`).
	const helpRef = useRef<ScrollBoxRenderable | null>(null);
	// The copilot's input. It OWNS its text; the reducer only ever pushes a whole new value at it
	// (a shortcut expansion, a recalled prompt, the clear after a send) through `copilotSetText`.
	const inputRef = useRef<TextareaRenderable | null>(null);
	// The same input, opened as a prompt for a card's action or a typed answer.
	const promptRef = useRef<TextareaRenderable | null>(null);

	const filtersFor = useCallback(
		(s: BoardNav.BoardState): BoardData.BoardFilters => ({
			kind: s.kind === "all" ? undefined : s.kind,
			scopeUri: s.scoped ? scopeRef.current?.scopeUri : undefined,
		}),
		[],
	);

	// Fire the FTS tier-2 search and merge results into the current state.
	const fireFts = useCallback(
		async (s: BoardNav.BoardState): Promise<void> => {
			const query = BoardNav.activeQuery(s.search);
			if (!query) return;
			const result = await BoardData.searchBoard(
				basePath,
				query,
				filtersFor(s),
			);
			if (!result.ok) return;
			updateState((prev) =>
				BoardNav.withSearchResults(prev, query, result.value),
			);
		},
		[basePath, filtersFor, updateState],
	);

	// Store the records of the open detail view and the stamp they carry.
	const showDetail = useCallback(
		(taskId: string, records: Result<BoardData.DetailRecords>): void => {
			detailLoadedId.current = taskId;
			detailStamp.current = records.ok
				? BoardData.recordsStamp(records.value)
				: null;
			setDetailRecords(records);
		},
		[],
	);

	// A comment, work log or session activity lands without touching the task row, so the open
	// detail view checks the cheap stamp on every poll and reloads its records only when it moved.
	// The records are replaced in place, never cleared, so the view keeps its tab and its scroll.
	// A failed read keeps what is on screen: the board's own poll already reports a broken store.
	const refreshDetail = useCallback(
		async (taskId: string): Promise<void> => {
			const stamp = await BoardData.detailStamp(basePath, taskId);
			if (!stamp.ok || stamp.value === detailStamp.current) return;
			const records = await BoardData.taskDetail(basePath, taskId);
			const open = stateRef.current?.view;
			if (open?.type !== "detail" || open.taskId !== taskId) return;
			if (records.ok) showDetail(taskId, records);
		},
		[basePath, showDetail, stateRef],
	);

	// Reload columns using the filters implied by `s`, then merge them in preserving selection.
	// When a query is active, re-fire the FTS search after the reload so tier-2 results stay merged.
	const reload = useCallback(
		async (s: BoardNav.BoardState): Promise<void> => {
			const [result, act] = await Promise.all([
				BoardData.loadBoard(basePath, filtersFor(s)),
				BoardActivity.loadActivity(basePath, activitySource),
			]);
			if (!result.ok) {
				// Non-fatal: keep last-good state, surface as a transient notice.
				setNotice({ text: result.error.message, tone: "error" });
				return;
			}
			// Clear any previous poll-error notice on success.
			setNotice((prev) => (prev?.tone === "error" ? null : prev));
			updateState((prev) => BoardNav.withSections(prev, result.value));
			if (act.ok) setActivity(act.value);
			const links = await BoardData.loadLinkedTaskIds(basePath, result.value);
			if (links.ok) setLinked(links.value);
			if (BoardNav.activeQuery(s.search)) void fireFts(s);
			if (s.view.type === "detail") void refreshDetail(s.view.taskId);
		},
		[
			basePath,
			filtersFor,
			fireFts,
			activitySource,
			refreshDetail,
			updateState,
			setNotice,
		],
	);

	// Copy a task's exact assembled brief to the system clipboard, flashing the outcome in the footer.
	// Uses the raw BoardData.taskBrief string (what David pastes to agents), not the rendered markdown.
	const runCopy = useCallback(
		async (id: string): Promise<void> => {
			const brief = await BoardData.taskBrief(basePath, id);
			if (!brief.ok) {
				setNotice({ text: brief.error.message, tone: "error" });
				return;
			}
			const wrote = await Clipboard.write(renderer, brief.value);
			setNotice(
				wrote.ok
					? { text: "copied brief to clipboard", tone: "success" }
					: { text: wrote.error.message, tone: "error" },
			);
		},
		[basePath, renderer, setNotice],
	);

	// `O`: hand the task's linked issue to the OS. Several links open the first — the picker a rare
	// case would want costs a modal on the common one, and the detail brief lists them all anyway.
	// The clipboard leg of the chain gets this renderer so it can reach OSC 52 over ssh.
	const runOpenLink = useCallback(
		async (id: string): Promise<void> => {
			const links = await BoardData.taskLinks(basePath, id);
			if (!links.ok) {
				setNotice({ text: links.error.message, tone: "error" });
				return;
			}
			const link = links.value[0];
			if (!link) {
				setNotice({ text: "no linked issue", tone: "error" });
				return;
			}
			const target = {
				provider: link.provider,
				identifier: link.identifier,
				url: link.url,
			};
			const opened = await Launcher.open(target, {
				copy: async (text) => (await Clipboard.write(renderer, text)).ok,
			});
			const name = Launcher.label(target);
			if (!opened.ok) {
				setNotice({ text: opened.error.message, tone: "error" });
				return;
			}
			setNotice(
				opened.value === "clipboard"
					? { text: `no opener · ${name} copied`, tone: "success" }
					: { text: `opening ${name} in ${link.provider}`, tone: "success" },
			);
		},
		[basePath, renderer, setNotice],
	);

	// Ask the host what it can start on this task; merge the answer into the open overlay. Without a
	// dispatcher the overlay closes and the footer says so — never silent.
	const loadTriggers = useCallback(
		async (taskId: string): Promise<void> => {
			if (!dispatcher) {
				updateState((prev) => ({ ...prev, dispatch: null }));
				setNotice(noDispatcher(copilot));
				return;
			}
			const result = await dispatcher.triggers(taskId);
			if (!result.ok) {
				updateState((prev) => ({ ...prev, dispatch: null }));
				setNotice({ text: result.error.message, tone: "error" });
				return;
			}
			updateState((prev) => BoardNav.withTriggers(prev, result.value));
		},
		[dispatcher, copilot, updateState, setNotice],
	);

	// Run a confirmed dispatch: assemble the brief, hand the host the target, and flash the outcome.
	// Never silent — success flashes the host's notice, failure the error message.
	const runDispatch = useCallback(
		async (
			s: BoardNav.BoardState,
			triggerId: string,
			id: string,
			inputs?: Readonly<Record<string, unknown>>,
		): Promise<void> => {
			if (!dispatcher) {
				setNotice(noDispatcher(copilot));
				return;
			}
			const task = BoardNav.taskById(s, id);
			const shortId = shortIdOf(task, id);
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
			setNotice(
				res.ok
					? { text: res.value, tone: "success" }
					: { text: res.error.message, tone: "error" },
			);
			// Refresh activity so a newly started card shows up.
			const current = stateRef.current;
			if (current) void reload(current);
		},
		[dispatcher, copilot, basePath, reload, stateRef, setNotice],
	);

	// One copilot turn: assemble the context, stream the run into the log, reload the board on each
	// completed write, and hand the reducer the turn's end. The stream is the one place the port can
	// throw at us (an AsyncIterable has no Result), so the boundary catches and ends the turn as an
	// error rather than letting it reach React.
	const runCopilot = useCallback(
		async (s: BoardNav.BoardState, prompt: string): Promise<void> => {
			const endTurn = (turn: BoardNav.CopilotTurn): void =>
				updateState((prev) => BoardNav.withCopilotTurn(prev, turn));
			const now = (): string => new Date().toISOString();
			if (!copilot) {
				setNotice(NO_COPILOT);
				endTurn("idle");
				return;
			}
			const turn = ++turnRef.current;
			// Behind this turn, the ones before it: the prompt is what opens a new one in the log.
			let log = CopilotLog.start(copilotLogRef.current, prompt, now());
			publishLog(log);
			const fail = (summary: string): void => {
				log = CopilotLog.apply(log, { type: "error", summary, at: now() });
				publishLog(log);
				endTurn("error");
			};
			const context = await BoardContext.load(basePath, s, scopeRef.current);
			if (turnRef.current !== turn) return;
			if (!context.ok) {
				fail(context.error.message);
				return;
			}
			try {
				for await (const update of copilot.run(prompt, context.value)) {
					if (turnRef.current !== turn) return;
					log = CopilotLog.apply(log, update);
					publishLog(log);
					// The harness is blocked from here until the human presses something; the board
					// only puts the question on screen and carries on rendering.
					if (update.type === "permission")
						updateState((prev) =>
							BoardNav.withCopilotPermission(prev, update.request),
						);
					if (update.type === "elicitation")
						updateState((prev) =>
							BoardNav.withCopilotElicitation(prev, update.request),
						);
					// Taken back unanswered: the block goes, and when it was the one on screen the
					// footer says why it went. A key already on its way answers nothing, since the
					// copilot no longer holds the request.
					if (update.type === "withdrawn") {
						if (stateRef.current?.copilot.asks[0]?.request.id === update.id)
							setNotice({ text: update.summary, tone: "error" });
						updateState((prev) =>
							BoardNav.withCopilotWithdrawn(prev, update.id),
						);
					}
					if (update.type === "commands")
						updateState((prev) =>
							BoardNav.withCopilotCommands(
								prev,
								update.source,
								update.commands,
							),
						);
					if (update.type === "tool_result" && update.wrote) {
						const current = stateRef.current;
						if (current) void reload(current);
					}
					if (update.type === "done") endTurn("done");
					if (update.type === "error") endTurn("error");
				}
				// A stream that ends without saying so still ended.
				if (log.current.card.status === "running") {
					log = CopilotLog.apply(log, { type: "done", summary: "", at: now() });
					publishLog(log);
					endTurn("done");
				}
			} catch (e) {
				if (turnRef.current === turn) fail(errorMessage(e));
			}
		},
		[copilot, basePath, reload, publishLog, setNotice, stateRef, updateState],
	);

	// Stop the turn in flight: tell the copilot, drop its remaining updates, close the card.
	const cancelCopilot = useCallback((): void => {
		turnRef.current++;
		void copilot?.cancel();
		const log = copilotLogRef.current;
		if (log && log.current.card.status === "running")
			publishLog(CopilotLog.cancelled(log, new Date().toISOString()));
		updateState((prev) => BoardNav.withCopilotTurn(prev, "error"));
	}, [copilot, publishLog, updateState]);

	// `o` in the detail view: the task's first in-flight card with events, else its most recent one.
	// A card with a tab of its own opens as that tab, so one card never shows in two places.
	const openEvents = useCallback(
		(s: BoardNav.BoardState, taskId: string): void => {
			const cards = BoardActivity.cardsForTask(
				activityRef.current,
				taskId,
				BoardNav.taskById(s, taskId)?.shortId,
			).filter((c) => c.hasEvents);
			const target =
				cards.find((c) => c.status === "running" || c.status === "pending") ??
				cards[0];
			if (!target) {
				setNotice({ text: "no events", tone: "success" });
				return;
			}
			if (s.tabs.open.includes(target.id)) {
				setState(
					BoardTabs.reduceMouse(s, { type: "tab", id: target.id }).state,
				);
				return;
			}
			setState({
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
		[setNotice, setState],
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
			await shownSource.answering?.(questionId);
			const res = await BoardData.answerQuestion(basePath, questionId, text);
			setNotice(flash(res, `answered ${text}`));
			updateState((prev) =>
				(res.ok ? BoardTabs.withAnswered : BoardTabs.withoutAnswer)(
					prev,
					questionId,
					text,
				),
			);
			await reload(s);
		},
		[basePath, reload, shownSource, updateState, setNotice],
	);

	// `w` closed a finished card's tab: the host forgets it, so a relaunch does not bring it back. The
	// tab is already gone either way; only a failure has anything to say.
	const dismissCard = useCallback(
		async (cardId: string): Promise<void> => {
			const res = await shownSource.dismiss?.(cardId);
			if (res && !res.ok) setNotice({ text: res.error.message, tone: "error" });
		},
		[shownSource, setNotice],
	);

	// One of a card's actions: the host runs it and says what happened, and the reload shows it.
	const runAct = useCallback(
		async (
			s: BoardNav.BoardState,
			effect: Extract<BoardNav.Effect, { type: "act" }>,
		): Promise<void> => {
			const { cardId, actionId, text, lane } = effect;
			const res = shownSource.act
				? await shownSource.act(cardId, actionId, {
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
		[shownSource, reload, setNotice],
	);

	// The single effect runner, shared by the keyboard and mouse dispatchers so both interaction paths
	// execute the reducer's output the same way. `next` is the post-reduce state a reload merges into.
	const runEffect = useCallback(
		(next: BoardNav.BoardState, effect: BoardNav.Effect): void => {
			switch (effect.type) {
				case "quit":
					renderer.destroy();
					return;
				case "reload":
					void reload(next);
					return;
				case "setState":
					void (async () => {
						const res = await BoardData.setTaskState(
							basePath,
							effect.id,
							effect.state,
						);
						setNotice({ ...flash(res, effect.notice), undoable: res.ok });
						await reload(next);
					})();
					return;
				case "markDone":
					void (async () => {
						const res = await BoardData.markDone(basePath, effect.id);
						setNotice({ ...flash(res, effect.notice), undoable: res.ok });
						await reload(next);
					})();
					return;
				case "markReviewed":
					void (async () => {
						const res = await BoardData.markReviewed(basePath, effect.id);
						setNotice({ ...flash(res, effect.notice), undoable: res.ok });
						await reload(next);
					})();
					return;
				case "applyUndo":
					// The reverse patch (not itself undoable — no redo). Mirrors the mutation cases: apply,
					// flash the outcome, reload so the board reflects the walked-back state.
					void (async () => {
						const res = await BoardData.applyUndo(
							basePath,
							effect.id,
							effect.patch,
						);
						setNotice(flash(res, effect.notice));
						await reload(next);
					})();
					return;
				case "scroll":
					scrollRef.current?.scrollBy(effect.delta);
					return;
				case "helpScroll":
					helpRef.current?.scrollBy(effect.delta);
					return;
				case "copy":
					void runCopy(effect.id);
					return;
				case "openLink":
					void runOpenLink(effect.id);
					return;
				case "notice":
					setNotice(effect.notice);
					return;
				case "dispatch":
					void runDispatch(next, effect.triggerId, effect.id, effect.inputs);
					return;
				case "loadTriggers":
					void loadTriggers(effect.taskId);
					return;
				case "copilotOpen":
					// Focus moved optimistically; without a copilot it goes straight back with the flash.
					if (!copilot) {
						updateState((prev) => ({ ...prev, focus: "board" }));
						setNotice(NO_COPILOT);
					}
					return;
				case "copilotPrompt":
					void runCopilot(next, effect.prompt);
					return;
				case "copilotCancel":
					cancelCopilot();
					return;
				case "copilotAnswer":
					copilot?.answerPermission(effect.id, effect.optionId);
					return;
				case "copilotAnswerForm":
					copilot?.answerElicitation(effect.id, effect.answer);
					return;
				case "copilotSetText":
				case "promptSetText":
					(effect.type === "copilotSetText"
						? inputRef
						: promptRef
					).current?.setText(effect.text);
					return;
				case "answerQuestion":
					void answer(next, effect.questionId, effect.answer);
					return;
				case "dismiss":
					void dismissCard(effect.cardId);
					return;
				case "act":
					void runAct(next, effect);
					return;
				case "openEvents":
					openEvents(next, effect.taskId);
					break;
				case "none":
					break;
			}
		},
		[
			renderer,
			reload,
			basePath,
			runCopy,
			runOpenLink,
			runDispatch,
			loadTriggers,
			copilot,
			runCopilot,
			cancelCopilot,
			answer,
			dismissCard,
			runAct,
			openEvents,
			setNotice,
			updateState,
		],
	);

	// Route a board mouse action through the same pure reducer as keys, then run its effect. Keeps
	// selection single-sourced — the mouse handlers never call setState with an ad-hoc coordinate.
	const dispatchMouse = useCallback(
		(action: BoardNav.MouseAction): void => {
			const current = stateRef.current;
			if (!current) return;
			const { state: next, effect } = BoardNav.reduceMouse(current, action);
			if (next !== current) {
				setState(next);
			}
			runEffect(next, effect);
		},
		[runEffect, stateRef, setState],
	);

	// Track a retry counter so the initial-load effect can be re-triggered by `r` from the error screen.
	const [retryCount, setRetryCount] = useState(0);

	useKeyboard((key) => {
		// Error screen: `r` retries the initial load, `q` quits.
		if (error) {
			if (key.name === "r") {
				setError(null);
				setRetryCount((c) => c + 1);
			} else if (key.name === "q") {
				renderer.destroy();
			}
			return;
		}
		const current = stateRef.current;
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
		const { state: next, effect } = BoardNav.reduceKey(current, key, clock());
		if (next !== current) {
			setState(next);
		}
		runEffect(next, effect);
	});

	// The textarea's own `submit` binding (enter). The reducer decides expand-versus-send so the
	// `/name` rule lives in one place.
	const submitCopilot = useCallback((): void => {
		const current = stateRef.current;
		if (!current) return;
		const text = inputRef.current?.plainText ?? "";
		const { state: next, effect } = BoardNav.submitCopilot(current, text);
		setState(next);
		runEffect(next, effect);
	}, [runEffect, stateRef, setState]);

	// `enter` in a form's input: the reducer reads the field and moves the form on, or sends it.
	const submitForm = useCallback(
		(text: string): void => {
			const current = stateRef.current;
			if (!current) return;
			const { state: next, effect } = BoardNav.submitForm(current, text);
			setState(next);
			runEffect(next, effect);
		},
		[runEffect, stateRef, setState],
	);

	// Mirror the buffer into the reducer so `/` matching sees what the human sees.
	const mirrorCopilotText = useCallback((): void => {
		const text = inputRef.current?.plainText ?? "";
		updateState((prev) => BoardNav.withCopilotText(prev, text));
	}, [updateState]);

	// The same two for a prompt a card's tab or a banner opened.
	const submitPrompt = useCallback((): void => {
		const current = stateRef.current;
		if (!current) return;
		const text = promptRef.current?.plainText ?? "";
		const { state: next, effect } = BoardPrompt.submit(current, text);
		setState(next);
		runEffect(next, effect);
	}, [runEffect, stateRef, setState]);
	const mirrorPromptText = useCallback((): void => {
		const text = promptRef.current?.plainText ?? "";
		updateState((prev) => BoardPrompt.withText(prev, text));
	}, [updateState]);

	// Initial load: detect scope, then build the first state scoped to the project (if any).
	// retryCount is in deps so `r` from the error screen re-triggers this effect.
	useEffect(() => {
		void retryCount;
		let cancelled = false;
		void (async () => {
			const detected = resolveScope ? await resolveScope(cwd) : null;
			const filters: BoardData.BoardFilters = detected
				? { scopeUri: detected.scopeUri }
				: {};
			const [result, act] = await Promise.all([
				BoardData.loadBoard(basePath, filters),
				BoardActivity.loadActivity(basePath, activitySource),
			]);
			if (cancelled) return;
			setScope(detected);
			if (act.ok) setActivity(act.value);
			if (result.ok) {
				const links = await BoardData.loadLinkedTaskIds(basePath, result.value);
				if (!cancelled && links.ok) setLinked(links.value);
			}
			if (result.ok)
				setState(
					BoardNav.withCopilotPort(
						BoardNav.init(result.value, { scoped: Boolean(detected) }),
						{
							shortcuts: copilot?.shortcuts() ?? [],
							actor: copilot?.actor ?? null,
						},
					),
				);
			else setError(result.error.message);
		})();
		return () => {
			cancelled = true;
		};
	}, [
		cwd,
		basePath,
		resolveScope,
		activitySource,
		copilot,
		retryCount,
		setState,
	]);

	// 5s background poll — reloads with whatever filters are currently active.
	useEffect(() => {
		const timer = setInterval(() => {
			const current = stateRef.current;
			if (current) void reload(current);
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [reload, stateRef]);

	// Tier-2 FTS: debounced 200ms while typing, immediate on commit. Fires on every search query
	// change so FTS results merge into the board alongside the instant client-side tier-1 filter.
	const searchQuery = state?.search.mode !== "off" ? state?.search.query : null;
	const searchMode = state?.search.mode ?? "off";
	useEffect(() => {
		const current = stateRef.current;
		if (!current || searchMode === "off" || !searchQuery) return;
		// Committed queries fire immediately (user pressed enter).
		const delay = searchMode === "committed" ? 0 : 200;
		const timer = setTimeout(() => {
			const latest = stateRef.current;
			if (latest) void fireFts(latest);
		}, delay);
		return () => clearTimeout(timer);
	}, [searchQuery, searchMode, fireFts, stateRef]);

	// Keep the selected row on-screen: whenever selection changes (j/k, mouse), scroll the minimum
	// distance to reveal it. Each row box carries id `row-<taskId>`, which scrollChildIntoView resolves.
	const selectedId = state?.view.type === "board" ? state.selectedId : null;
	useEffect(() => {
		if (selectedId) listRef.current?.scrollChildIntoView(`row-${selectedId}`);
	}, [selectedId]);

	// Fetch the detail view's records when it opens or the task changes. A different task opens on
	// its loading line; the same task refetches in place, so a v/x/n/s on it keeps tab and scroll.
	const detailTaskId = state?.view.type === "detail" ? state.view.taskId : null;
	const detailTask =
		detailTaskId && state ? BoardNav.taskById(state, detailTaskId) : undefined;
	// detailTask?.updatedAt is an intentional trigger — a v/x/n/s mutation on the open task re-fetches the records without changing taskId.
	useEffect(() => {
		if (detailLoadedId.current !== detailTaskId) {
			detailLoadedId.current = null;
			detailStamp.current = null;
			setDetailRecords(null);
		}
		if (!detailTaskId) return;
		let cancelled = false;
		void (async () => {
			const result = await BoardData.taskDetail(basePath, detailTaskId);
			if (cancelled) return;
			showDetail(detailTaskId, result);
		})();
		return () => {
			cancelled = true;
		};
	}, [basePath, detailTaskId, detailTask?.updatedAt, showDetail]);

	// The tab bar follows the cards that ask for a tab, and the attention queue follows the tracker's
	// unanswered questions, both on every activity load.
	useEffect(() => {
		updateState((prev) =>
			BoardTabs.withActivity(
				prev,
				shownActivity.cards,
				BoardActivity.questions(shownActivity),
			),
		);
	}, [shownActivity, updateState]);

	const spinnerFrame = useSpinnerFrame(anyActivityRunning(shownActivity));

	// The event view on a card's tab refreshes its card every second; the keys read the same card.
	const takeCard = useCallback(
		(card: ActivityCard): void => {
			updateState((prev) => BoardTabs.withCard(prev, card));
		},
		[updateState],
	);

	// Resolve task ULID → shortId from loaded sections (for the event view's header).
	const resolveShortId = useCallback(
		(taskId: string): string | undefined => {
			const task = stateRef.current
				? BoardNav.taskById(stateRef.current, taskId)
				: undefined;
			return task ? shortIdOf(task, task.id) : undefined;
		},
		[stateRef],
	);

	if (error)
		return (
			<text fg={theme.failed}>
				Failed to load board: {error}
				{"\n"}
				<text fg={theme.muted}>press r to retry · q to quit</text>
			</text>
		);
	if (!state) return <text fg={theme.defaultFg}>Loading…</text>;

	// Which keys are live and what they can act on, once for the footer and the `?` sheet alike.
	const openTaskId = state.view.type === "detail" ? state.view.taskId : null;
	// The host's own header for the card whose tab is on screen, by its kind.
	const activeKind = shownActivity.cards.find(
		(c) => c.id === state.tabs.active,
	)?.kind;
	const cardHeader = activeKind ? headers?.[activeKind] : undefined;
	const situation = BoardNav.keySituation(state, {
		linked,
		header: cardHeader !== undefined,
		events:
			openTaskId !== null &&
			BoardActivity.cardsForTask(
				shownActivity,
				openTaskId,
				BoardNav.taskById(state, openTaskId)?.shortId,
			).some((c) => c.hasEvents),
	});
	const keys = {
		context: BoardNav.keyContext(state),
		situation,
		host: CardTab.hints(state),
	};
	// The dispatch overlay floats over WHICHEVER view it opened on (it's a separate state field, not a
	// view), so both branches render inside the same full-screen wrapper it absolutely positions against.
	// The `?` sheet is the same kind of thing, anchored at the bottom instead of centred.
	const overlay = state.help ? (
		<HelpSheet
			context={BoardNav.sheetContext(state)}
			situation={situation}
			scrollRef={helpRef}
			host={keys.host}
		/>
	) : state.dispatch ? (
		<DispatchLayer
			shortId={shortIdOf(
				BoardNav.taskById(state, state.dispatch.taskId),
				state.dispatch.taskId,
			)}
			overlay={state.dispatch}
			onField={(index) => dispatchMouse({ type: "formField", index })}
		/>
	) : null;
	// The pane is always mounted — one row unfocused, the panel when focused — so the copilot is a
	// place on screen rather than something that appears when summoned.
	const copilotPane = (
		<CopilotPane
			copilot={state.copilot}
			// Briefs are fetched on submit; the chip only needs the ids the state already holds.
			chip={contextChip(BoardContext.project(state, scope, new Map()))}
			focused={state.focus === "copilot"}
			log={copilotLog}
			spinnerFrame={spinnerFrame}
			detailShownElsewhere={
				state.view.type === "events" && state.view.cardId === CopilotLog.CARD_ID
			}
			outranked={BoardNav.copilotOutranked(state)}
			askInHand={BoardNav.askInHand(state)}
			reach={BoardNav.askReach(state)}
			textareaRef={inputRef}
			onSubmit={submitCopilot}
			onContentChange={mirrorCopilotText}
			onFormSubmit={submitForm}
			onAsk={dispatchMouse}
		/>
	);
	// A prompt a card's tab or a banner opened sits where the copilot's panel would, above its row.
	const opened = state.prompt.open;
	const pane = (
		<>
			{opened ? (
				<PromptPanel
					title={opened.title}
					aim={opened.aim}
					placeholder={opened.placeholder}
					text={state.prompt.text}
					textareaRef={promptRef}
					onSubmit={submitPrompt}
					onContentChange={mirrorPromptText}
				/>
			) : null}
			{copilotPane}
		</>
	);
	// Every view sits under the tab bar; the overlays float over whichever view is on screen. Every
	// footer in it ends on the copilot session's context reading, when there is one.
	const { tabs } = state;
	const framed = (view: ReactNode): ReactNode => (
		<FooterTrail.Provider value={CopilotLog.usageLabel(copilotLog)}>
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<TabBar
					tabs={tabs}
					cards={shownActivity.cards}
					spinnerFrame={spinnerFrame}
					onSelect={(id) => dispatchMouse({ type: "tab", id })}
				/>
				<box style={{ flexDirection: "column", flexGrow: 1 }}>{view}</box>
				{overlay}
			</box>
		</FooterTrail.Provider>
	);

	if (state.view.type === "events") {
		const { cardId } = state.view;
		return framed(
			<EventView
				// One view per card: switching tabs remounts it on the other card's events.
				key={cardId}
				cardId={cardId}
				initialCard={shownActivity.cards.find((c) => c.id === cardId)}
				source={shownSource}
				resolveShortId={resolveShortId}
				scrollRef={scrollRef}
				notice={notice}
				plan={
					cardId === CopilotLog.CARD_ID ? copilotLog?.current.plan : undefined
				}
				// The transcript draws a permission at the head of the queue; a form there is the
				// pane's to draw, since it takes the keys.
				permissions={
					cardId === CopilotLog.CARD_ID &&
					state.copilot.asks[0]?.type === "permission"
						? state.copilot.asks.flatMap((ask) =>
								ask.type === "permission" ? [ask.request] : [],
							)
						: undefined
				}
				onAsk={dispatchMouse}
				tabbed={tabs.active === cardId}
				lane={CardTab.view(tabs, cardId).lane}
				onLane={(index) => dispatchMouse({ type: "lane", index })}
				onCard={takeCard}
				header={tabs.active === cardId ? cardHeader : undefined}
				expanded={CardTab.view(tabs, cardId).expanded}
				toolDetails={state.view.toolDetails ?? false}
				// On a card's own tab, the question its sessions wait on, answered in place.
				banner={
					<CardTabQuestion
						tabs={tabs}
						onAnswer={(index) => dispatchMouse({ type: "answer", index })}
					/>
				}
				keys={keys}
				pane={pane}
			/>,
		);
	}

	if (state.view.type === "detail") {
		const { taskId, banner } = state.view;
		const task = BoardNav.taskById(state, taskId);
		const taskCards = BoardActivity.cardsForTask(
			shownActivity,
			taskId,
			task?.shortId,
		);
		return framed(
			<>
				<PinnedQuestion
					tabs={tabs}
					banner={banner}
					cards={shownActivity.cards}
					onAnswer={(index) => dispatchMouse({ type: "answer", index })}
				/>
				<Detail
					taskId={taskId}
					task={task}
					records={detailRecords ?? undefined}
					cards={taskCards.length > 0 ? taskCards : undefined}
					questions={shownActivity.questionsByTaskId.get(taskId)}
					pinned={banner?.question.questionActivityId}
					tab={BoardNav.detailTab(state.view)}
					onTab={(tab) => dispatchMouse({ type: "detailTab", tab })}
					scrollRef={scrollRef}
					notice={notice}
					focus={state.focus}
					pane={pane}
					linked={linked.has(taskId)}
					keys={keys}
					onCopy={() => dispatchMouse({ type: "copy" })}
				/>
			</>,
		);
	}

	const scopeLabel = state.scoped && scope ? scope.label : "all scopes";
	return framed(
		<Board
			sections={state.sections}
			expanded={state.expanded}
			selectedId={state.selectedId}
			search={state.search}
			activity={shownActivity}
			scopeLabel={scopeLabel}
			kind={state.kind}
			status={state.status}
			marked={state.marked}
			// The reload after each of the copilot's writes is what puts the fresh `updatedBy`
			// and `updatedAt` in hand; the reducer decides which of them the glyph is for.
			touched={BoardNav.copilotTouched(
				state,
				copilotLog?.current.card.startedAt,
			)}
			linked={linked}
			keys={keys}
			scrollRef={listRef}
			onSelect={(row) => dispatchMouse({ type: "select", row })}
			onToggle={(row) => dispatchMouse({ type: "toggleExpand", row })}
			notice={notice}
			focus={state.focus}
			pane={pane}
		/>,
	);
};
