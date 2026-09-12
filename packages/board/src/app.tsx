/** @jsxImportSource @opentui/react */
// Top-level board screen: loads planner data, holds board + selection state, and drives every
// interaction through ONE useKeyboard handler that delegates to BoardNav.reduceKey (the pure key
// router) and runs the effect it returns. A 5s poll keeps the board fresh; selection survives every
// reload by task id. The board starts scoped to the detected project — `esc` widens to all scopes.
import { Planner, type Task, type TaskComment } from "@cabane/core";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react";
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
import { Clipboard } from "./clipboard";
import { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { CopilotPane, contextChip } from "./copilot-prompt";
import { BoardData } from "./data";
import { Detail } from "./detail";
import { EventView } from "./event-view";
import { BoardNav } from "./nav";
import { DispatchOverlay, HelpOverlay } from "./overlay";
import type { ActivitySource, Copilot, Dispatcher } from "./ports";
import {
	buildSidebarItems,
	MIN_SIDEBAR_COLS,
	Sidebar,
	sidebarWidth,
} from "./sidebar";
import { useSpinnerFrame } from "./spinner";

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
};

const POLL_INTERVAL_MS = 5000;
// How long the footer flash stays before clearing.
const NOTICE_MS = 1500;
// Undoable mutations hold their flash longer so the ⌃z hint has time to register.
const UNDO_HINT_MS = 4000;

// Turn a mutation Result into the footer flash: the reducer's composed text on success, the raw error
// message on failure. Structural on Result<T> so it works for every BoardData mutation.
const flash = (
	res: { ok: true } | { ok: false; error: { message: string } },
	text: string,
): BoardNav.Notice =>
	res.ok
		? { text, tone: "success" }
		: { text: res.error.message, tone: "error" };

// Find a task anywhere in the loaded sections (top-level or subtask) — the detail view's and the
// dispatch overlay's lookup, both of which may target a subtask the selection can't address.
const findTask = (state: BoardNav.BoardState, id: string): Task | undefined =>
	state.sections
		.flatMap((section) => section.rows)
		.flatMap((row) => [row.task, ...row.children])
		.find((t) => t.id === id);

const shortIdOf = (task: Task | undefined, id: string): string =>
	task?.shortId ?? id.slice(0, 8);

const NO_COPILOT: BoardNav.Notice = {
	text: "no copilot configured",
	tone: "error",
};

const errorMessage = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

// Sidebar cards from hosts that only know the label: find the task by its shortId.
const taskIdByShortId = (
	state: BoardNav.BoardState,
	shortId: string | undefined,
): string | null => {
	if (!shortId) return null;
	for (const section of state.sections) {
		for (const { task, children } of section.rows) {
			if (task.shortId === shortId) return task.id;
			for (const child of children)
				if (child.shortId === shortId) return child.id;
		}
	}
	return null;
};

export const App = ({
	cwd,
	basePath,
	activity: activitySource,
	dispatcher,
	copilot,
	resolveScope,
}: AppProps): ReactNode => {
	const renderer = useRenderer();
	const [state, setState] = useState<BoardNav.BoardState | null>(null);
	const [scope, setScope] = useState<BoardData.ScopeInfo | null>(null);
	// In-flight host cards + awaiting-input questions, refreshed by the same poll as the board data. A
	// failed activity read keeps the previous map — the board is a glance surface, badges degrade quietly.
	const [activity, setActivity] = useState<BoardActivity.ActivityMap>(
		BoardActivity.emptyActivity(),
	);
	const [error, setError] = useState<string | null>(null);
	// Transient footer flash, auto-cleared after NOTICE_MS. Never silent — copies, state moves, review,
	// and cancel all surface a notice; failures show the error, successes a confirmation.
	const [notice, setNotice] = useState<BoardNav.Notice | null>(null);
	// Comments for the currently open detail view. Fetched alongside the brief, cleared on view change.
	const [detailComments, setDetailComments] = useState<TaskComment[]>([]);
	// The copilot's current turn: its card and transcript, replaced on the next turn, never persisted.
	// Held in a ref as well because the composed ActivitySource below reads it while the event view
	// polls, and the stream runner writes it between renders.
	const [copilotLog, setCopilotLog] = useState<CopilotLog.Log | null>(null);
	const copilotLogRef = useRef<CopilotLog.Log | null>(null);
	const publishLog = useCallback((log: CopilotLog.Log): void => {
		copilotLogRef.current = log;
		setCopilotLog(log);
	}, []);
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
	// The key and mouse dispatchers also write it as soon as they reduce, so keys that land between
	// renders (a paste into the prompt or the search box) each see the previous key's result.
	const stateRef = useRef<BoardNav.BoardState | null>(null);
	stateRef.current = state;
	const scopeRef = useRef<BoardData.ScopeInfo | null>(null);
	scopeRef.current = scope;
	const activityRef = useRef<BoardActivity.ActivityMap>(shownActivity);
	activityRef.current = shownActivity;
	// The detail view's scrollbox lives inside <Detail>; app.tsx holds the ref so the `scroll` effect
	// can drive it and every key stays in the one useKeyboard handler.
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	// The board list's scrollbox; app.tsx keeps the selected row in view as j/k move it off-screen.
	const listRef = useRef<ScrollBoxRenderable | null>(null);
	// The copilot's input. It OWNS its text; the reducer only ever pushes a whole new value at it
	// (a shortcut expansion, a recalled prompt, the clear after a send) through `copilotSetText`.
	const inputRef = useRef<TextareaRenderable | null>(null);

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
			setState((prev) =>
				prev ? BoardNav.withSearchResults(prev, query, result.value) : prev,
			);
		},
		[basePath, filtersFor],
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
			setState((prev) =>
				prev ? BoardNav.withSections(prev, result.value) : prev,
			);
			if (act.ok) setActivity(act.value);
			if (BoardNav.activeQuery(s.search)) void fireFts(s);
		},
		[basePath, filtersFor, fireFts, activitySource],
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
			const wrote = await Clipboard.write(brief.value, { osc52: renderer });
			setNotice(
				wrote.ok
					? { text: "copied brief to clipboard", tone: "success" }
					: { text: wrote.error.message, tone: "error" },
			);
		},
		[basePath, renderer],
	);

	// Ask the host what it can start on this task; merge the answer into the open overlay. Without a
	// dispatcher the overlay closes and the footer says so — never silent.
	const loadTriggers = useCallback(
		async (taskId: string): Promise<void> => {
			if (!dispatcher) {
				setState((prev) => (prev ? { ...prev, dispatch: null } : prev));
				setNotice({ text: "no dispatcher configured", tone: "error" });
				return;
			}
			const result = await dispatcher.triggers(taskId);
			if (!result.ok) {
				setState((prev) => (prev ? { ...prev, dispatch: null } : prev));
				setNotice({ text: result.error.message, tone: "error" });
				return;
			}
			setState((prev) =>
				prev ? BoardNav.withTriggers(prev, result.value) : prev,
			);
		},
		[dispatcher],
	);

	// Run a confirmed dispatch: assemble the brief, hand the host the target, and flash the outcome.
	// Never silent — success flashes the host's notice, failure the error message.
	const runDispatch = useCallback(
		async (
			s: BoardNav.BoardState,
			triggerId: string,
			id: string,
		): Promise<void> => {
			if (!dispatcher) {
				setNotice({ text: "no dispatcher configured", tone: "error" });
				return;
			}
			const task = findTask(s, id);
			const shortId = shortIdOf(task, id);
			const brief = await BoardData.taskBrief(basePath, id);
			if (!brief.ok) {
				setNotice({ text: brief.error.message, tone: "error" });
				return;
			}
			const res = await dispatcher.dispatch(triggerId, {
				id,
				shortId,
				title: task?.title ?? "",
				brief: brief.value,
			});
			setNotice(
				res.ok
					? { text: res.value, tone: "success" }
					: { text: res.error.message, tone: "error" },
			);
			// Refresh activity so a newly started card shows up.
			const current = stateRef.current;
			if (current) void reload(current);
		},
		[dispatcher, basePath, reload],
	);

	// One copilot turn: assemble the context, stream the run into the log, reload the board on each
	// completed write, and hand the reducer the turn's end. The stream is the one place the port can
	// throw at us (an AsyncIterable has no Result), so the boundary catches and ends the turn as an
	// error rather than letting it reach React.
	const runCopilot = useCallback(
		async (s: BoardNav.BoardState, prompt: string): Promise<void> => {
			const endTurn = (turn: BoardNav.CopilotTurn): void =>
				setState((prev) =>
					prev ? BoardNav.withCopilotTurn(prev, turn) : prev,
				);
			const now = (): string => new Date().toISOString();
			if (!copilot) {
				setNotice(NO_COPILOT);
				endTurn("idle");
				return;
			}
			const turn = ++turnRef.current;
			let log = CopilotLog.start(now());
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
					if (update.type === "tool_result") {
						const current = stateRef.current;
						if (current) void reload(current);
					}
					if (update.type === "done") endTurn("done");
					if (update.type === "error") endTurn("error");
				}
				// A stream that ends without saying so still ended.
				if (log.card.status === "running") {
					log = CopilotLog.apply(log, { type: "done", summary: "", at: now() });
					publishLog(log);
					endTurn("done");
				}
			} catch (e) {
				if (turnRef.current === turn) fail(errorMessage(e));
			}
		},
		[copilot, basePath, reload, publishLog],
	);

	// Stop the turn in flight: tell the copilot, drop its remaining updates, close the card.
	const cancelCopilot = useCallback((): void => {
		turnRef.current++;
		void copilot?.cancel();
		const log = copilotLogRef.current;
		if (log && log.card.status === "running")
			publishLog(CopilotLog.cancelled(log, new Date().toISOString()));
		setState((prev) => (prev ? BoardNav.withCopilotTurn(prev, "error") : prev));
	}, [copilot, publishLog]);

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
				case "copy":
					void runCopy(effect.id);
					return;
				case "notice":
					setNotice(effect.notice);
					return;
				case "dispatch":
					void runDispatch(next, effect.triggerId, effect.id);
					return;
				case "loadTriggers":
					void loadTriggers(effect.taskId);
					return;
				case "copilotOpen":
					// Focus moved optimistically; without a copilot it goes straight back with the flash.
					if (!copilot) {
						setState((prev) => (prev ? { ...prev, focus: "board" } : prev));
						setNotice(NO_COPILOT);
					}
					return;
				case "copilotPrompt":
					void runCopilot(next, effect.prompt);
					return;
				case "copilotCancel":
					cancelCopilot();
					return;
				case "copilotSetText":
					inputRef.current?.setText(effect.text);
					return;
				case "sidebarSelect": {
					// Read activity from the ref to avoid stale closure over sidebarItems.
					const currentItems = buildSidebarItems(activityRef.current);
					const item = currentItems[next.sidebar.selected];
					if (!item) return;
					if (item.type === "card" && item.card.hasEvents) {
						const fromTaskId =
							next.view.type === "detail" ? next.view.taskId : undefined;
						setState({
							...next,
							view: {
								type: "events",
								cardId: item.card.id,
								fromView: next.view.type === "detail" ? "detail" : "board",
								fromTaskId,
							},
							focus: "board",
						});
						return;
					}
					// A card without events, or a question: jump to its task.
					const taskId =
						item.type === "input"
							? item.question.taskId
							: (item.card.taskId ??
								taskIdByShortId(next, item.card.taskShortId));
					if (taskId) {
						setState({
							...next,
							view: { type: "detail", taskId },
							focus: "board",
						});
					}
					return;
				}
				case "openEvents": {
					// The first in-flight card with events for the task, else the most recent one.
					const cards = BoardActivity.cardsForTask(
						activityRef.current,
						effect.taskId,
						findTask(next, effect.taskId)?.shortId,
					).filter((c) => c.hasEvents);
					const target =
						cards.find(
							(c) => c.status === "running" || c.status === "pending",
						) ?? cards[0];
					if (!target) {
						setNotice({ text: "no events", tone: "success" });
						return;
					}
					setState({
						...next,
						view: {
							type: "events",
							cardId: target.id,
							fromView: "detail",
							fromTaskId: effect.taskId,
						},
					});
					return;
				}
				case "none":
					return;
			}
		},
		[
			renderer,
			reload,
			basePath,
			runCopy,
			runDispatch,
			loadTriggers,
			copilot,
			runCopilot,
			cancelCopilot,
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
				stateRef.current = next;
				setState(next);
			}
			runEffect(next, effect);
		},
		[runEffect],
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
		if (BoardNav.copilotConsumes(current, key)) key.preventDefault();
		const { state: next, effect } = BoardNav.reduceKey(current, key);
		if (next !== current) {
			stateRef.current = next;
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
		stateRef.current = next;
		setState(next);
		runEffect(next, effect);
	}, [runEffect]);

	// Mirror the buffer into the reducer so `/` matching sees what the human sees.
	const mirrorCopilotText = useCallback((): void => {
		const text = inputRef.current?.plainText ?? "";
		setState((prev) => (prev ? BoardNav.withCopilotText(prev, text) : prev));
	}, []);

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
			if (result.ok)
				setState(
					BoardNav.withCopilotShortcuts(
						BoardNav.init(result.value, { scoped: Boolean(detected) }),
						copilot?.shortcuts() ?? [],
					),
				);
			else setError(result.error.message);
		})();
		return () => {
			cancelled = true;
		};
	}, [cwd, basePath, resolveScope, activitySource, copilot, retryCount]);

	// 5s background poll — reloads with whatever filters are currently active.
	useEffect(() => {
		const timer = setInterval(() => {
			const current = stateRef.current;
			if (current) void reload(current);
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [reload]);

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
	}, [searchQuery, searchMode, fireFts]);

	// Clear the copy flash after NOTICE_MS (undoable mutations linger UNDO_HINT_MS so the ⌃z hint has
	// time to register). setNotice always makes a fresh object, so a repeat copy re-runs this and
	// restarts the timer.
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(
			() => setNotice(null),
			notice.undoable ? UNDO_HINT_MS : NOTICE_MS,
		);
		return () => clearTimeout(timer);
	}, [notice]);

	// Keep the selected row on-screen: whenever selection changes (j/k, mouse), scroll the minimum
	// distance to reveal it. Each row box carries id `row-<taskId>`, which scrollChildIntoView resolves.
	const selectedId = state?.view.type === "board" ? state.selectedId : null;
	useEffect(() => {
		if (selectedId) listRef.current?.scrollChildIntoView(`row-${selectedId}`);
	}, [selectedId]);

	// Fetch comments when the detail view opens or the task changes. Cleared on view change.
	const detailTaskId = state?.view.type === "detail" ? state.view.taskId : null;
	const detailTask =
		detailTaskId && state ? findTask(state, detailTaskId) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: detailTask?.updatedAt is an intentional trigger — a v/x/n/s mutation on the open task re-fetches comments without changing taskId.
	useEffect(() => {
		if (!detailTaskId) {
			setDetailComments([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			const result = await Planner.getComments(basePath, detailTaskId);
			if (cancelled) return;
			setDetailComments(result.ok ? result.value : []);
		})();
		return () => {
			cancelled = true;
		};
	}, [basePath, detailTaskId, detailTask?.updatedAt]);

	// Update sidebar itemCount whenever activity changes (so the reducer has correct bounds).
	useEffect(() => {
		setState((prev) => {
			if (!prev) return prev;
			const items = buildSidebarItems(shownActivity);
			if (prev.sidebar.itemCount === items.length) return prev;
			return {
				...prev,
				sidebar: {
					...prev.sidebar,
					itemCount: items.length,
					selected: Math.min(
						prev.sidebar.selected,
						Math.max(0, items.length - 1),
					),
				},
			};
		});
	}, [shownActivity]);

	const { width: termCols } = useTerminalDimensions();
	const spinnerFrame = useSpinnerFrame(anyActivityRunning(shownActivity));

	// Resolve task ULID → shortId from loaded sections (for sidebar display).
	const resolveShortId = useCallback((taskId: string): string | undefined => {
		const s = stateRef.current;
		if (!s) return undefined;
		for (const section of s.sections) {
			for (const { task, children } of section.rows) {
				if (task.id === taskId) return task.shortId ?? task.id.slice(0, 8);
				for (const child of children)
					if (child.id === taskId) return child.shortId ?? child.id.slice(0, 8);
			}
		}
		return undefined;
	}, []);

	if (error)
		return (
			<text fg="#ef4444">
				Failed to load board: {error}
				{"\n"}
				<text fg="#a1a1aa">press r to retry · q to quit</text>
			</text>
		);
	if (!state) return <text>Loading…</text>;

	// The dispatch overlay floats over WHICHEVER view it opened on (it's a separate state field, not a
	// view), so both branches render inside the same full-screen wrapper it absolutely positions against.
	// The copilot prompt is the same kind of thing, pinned above the footer instead of centred.
	const overlay = state.help ? (
		<HelpOverlay />
	) : state.dispatch ? (
		<DispatchOverlay
			shortId={shortIdOf(
				findTask(state, state.dispatch.taskId),
				state.dispatch.taskId,
			)}
			overlay={state.dispatch}
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
			textareaRef={inputRef}
			onSubmit={submitCopilot}
			onContentChange={mirrorCopilotText}
		/>
	);
	const showSidebar = state.sidebar.visible && termCols >= MIN_SIDEBAR_COLS;
	const sbWidth = showSidebar ? sidebarWidth(termCols) : 0;
	const sidebarEl = showSidebar ? (
		<Sidebar
			activity={shownActivity}
			sidebarWidth={sbWidth}
			focused={state.focus === "sidebar"}
			selectedIndex={state.sidebar.selected}
			spinnerFrame={spinnerFrame}
			resolveShortId={resolveShortId}
		/>
	) : null;

	if (state.view.type === "events") {
		const cardId = state.view.cardId;
		return (
			<box style={{ flexDirection: "row", flexGrow: 1 }}>
				<box style={{ flexDirection: "column", flexGrow: 1 }}>
					<EventView
						cardId={cardId}
						initialCard={shownActivity.cards.find((c) => c.id === cardId)}
						source={shownSource}
						resolveShortId={resolveShortId}
						scrollRef={scrollRef}
						notice={notice}
						extraHints={
							cardId === CopilotLog.CARD_ID && state.copilot.turn === "running"
								? "x cancel"
								: undefined
						}
						pane={copilotPane}
					/>
				</box>
				{sidebarEl}
				{overlay}
			</box>
		);
	}

	if (state.view.type === "detail") {
		const { taskId } = state.view;
		const task = findTask(state, taskId);
		const taskCards = BoardActivity.cardsForTask(
			shownActivity,
			taskId,
			task?.shortId,
		);
		return (
			<box style={{ flexDirection: "row", flexGrow: 1 }}>
				<box style={{ flexDirection: "column", flexGrow: 1 }}>
					<Detail
						basePath={basePath}
						taskId={taskId}
						task={task}
						cards={taskCards.length > 0 ? taskCards : undefined}
						comments={detailComments.length > 0 ? detailComments : undefined}
						questions={shownActivity.questionsByTaskId.get(taskId)}
						scrollRef={scrollRef}
						notice={notice}
						focus={state.focus}
						pane={copilotPane}
						onCopy={() => dispatchMouse({ type: "copy" })}
					/>
				</box>
				{sidebarEl}
				{overlay}
			</box>
		);
	}

	const scopeLabel = state.scoped && scope ? scope.label : "all scopes";
	return (
		<box style={{ flexDirection: "row", flexGrow: 1 }}>
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<Board
					sections={state.sections}
					expanded={state.expanded}
					selectedId={state.selectedId}
					search={state.search}
					activity={shownActivity}
					scopeLabel={scopeLabel}
					filterLabel={`kind: ${state.kind}`}
					status={state.status}
					marked={state.marked}
					scrollRef={listRef}
					onSelect={(row) => dispatchMouse({ type: "select", row })}
					onToggle={(row) => dispatchMouse({ type: "toggleExpand", row })}
					notice={notice}
					focus={state.focus}
					pane={copilotPane}
					sidebarWidth={sbWidth}
				/>
			</box>
			{sidebarEl}
			{overlay}
		</box>
	);
};
