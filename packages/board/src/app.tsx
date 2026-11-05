/** @jsxImportSource @opentui/react */
// Top-level board screen: loads planner data, holds board + selection state, and drives every
// interaction through ONE useKeyboard handler that delegates to BoardNav.reduceKey (the pure key
// router) and runs the effect it returns. A 5s poll keeps the board fresh; selection survives every
// reload by task id. The board starts scoped to the detected project — `esc` widens to all scopes.
import type { Task } from "@cabane/core";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { BoardActivity } from "./activity";
import { anyActivityRunning, Board } from "./board";
import { useBoardFeed } from "./board-feed";
import { useBoardStore } from "./board-store";
import { CardTab } from "./card-tab";
import { Clipboard } from "./clipboard";
import { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { CopilotPane, contextChip } from "./copilot-prompt";
import { NO_COPILOT, useCopilotSession } from "./copilot-session";
import { BoardData } from "./data";
import { Detail } from "./detail";
import { useDetailRecords } from "./detail-records";
import { EventView } from "./event-view";
import { FooterTrail } from "./footer";
import { Launcher } from "./launcher";
import { BoardNav } from "./nav";
import { flash, useNotice } from "./notice";
import { HelpSheet } from "./overlay";
import type { ActivitySource, CardHeader, Copilot, Dispatcher } from "./ports";
import { ProgramStatus } from "./program-status";
import { BoardPrompt } from "./prompt";
import { PromptPanel } from "./prompt-field";
import { useRunActivity } from "./run-activity";
import { useSpinnerFrame } from "./spinner";
import { CardTabQuestion, PinnedQuestion, TabBar } from "./tab-bar";
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

const shortIdOf = (task: Task | undefined, id: string): string =>
	task?.shortId ?? id.slice(0, 8);

// Without a dispatcher no extension is on. A copilot that can set kabane up is the way to turn one
// on without knowing the config's keys.
const noDispatcher = (copilot: Copilot | undefined): BoardNav.Notice => ({
	text: copilot?.shortcuts().some((s) => s.name === "setup")
		? "no extension dispatches here · /setup in the copilot turns on the loop"
		: "no dispatcher configured",
	tone: "error",
});

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
	const store = useBoardStore(clock);
	const { state, ref: stateRef, set: setState, update: updateState } = store;
	const [notice, setNotice] = useNotice();
	const { records: detailRecords, refresh: refreshDetail } = useDetailRecords(
		basePath,
		store,
	);
	const { scope, scopeRef, activity, linked, error, retry, reload } =
		useBoardFeed({
			cwd,
			basePath,
			activitySource,
			resolveScope,
			copilot,
			store,
			setNotice,
			refreshDetail,
		});
	const {
		log: copilotLog,
		current: currentLog,
		run: runCopilot,
		cancel: cancelCopilot,
	} = useCopilotSession({
		copilot,
		basePath,
		store,
		scopeRef,
		reload,
		setNotice,
	});
	const {
		shown: shownActivity,
		source: shownSource,
		answer,
		dismiss: dismissCard,
		act: runAct,
		openEvents,
		takeCard,
	} = useRunActivity({
		basePath,
		activity,
		activitySource,
		copilotLog,
		currentLog,
		store,
		setNotice,
		reload,
	});

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

	useKeyboard((key) => {
		// Error screen: `r` retries the initial load, `q` quits.
		if (error) {
			if (key.name === "r") retry();
			else if (key.name === "q") {
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

	// Keep the selected row on-screen: whenever selection changes (j/k, mouse), scroll the minimum
	// distance to reveal it. Each row box carries id `row-<taskId>`, which scrollChildIntoView resolves.
	const selectedId = state?.view.type === "board" ? state.selectedId : null;
	useEffect(() => {
		if (selectedId) listRef.current?.scrollChildIntoView(`row-${selectedId}`);
	}, [selectedId]);

	const spinnerFrame = useSpinnerFrame(anyActivityRunning(shownActivity));

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
			BoardActivity.eventsCard(
				shownActivity,
				openTaskId,
				BoardNav.taskById(state, openTaskId)?.shortId,
			) !== undefined,
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
					records={detailRecords}
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
