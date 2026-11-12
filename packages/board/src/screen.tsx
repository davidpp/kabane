/** @jsxImportSource @opentui/react */
// What the board puts on screen for a state: the tab bar over the view in hand (the board, a task's
// detail, a card's events), the copilot's pane and any open prompt under the view, and the overlays
// floating over whichever view is on screen. Every key and click goes back through BoardInput.
import type { Result } from "@cabane/core";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { BoardActivity } from "./activity";
import { anyActivityRunning, Board } from "./board";
import type { BoardInput } from "./board-input";
import { CardTab } from "./card-tab";
import { BoardChecklist } from "./checklist";
import { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { CopilotPane, contextChip } from "./copilot-prompt";
import type { BoardData } from "./data";
import { DecisionPanel, DecisionsWaiting } from "./decision-panel";
import { BoardDecisions } from "./decisions";
import { Detail } from "./detail";
import { DetailModel } from "./detail-model";
import type { Fresh } from "./detail-records";
import { EventView } from "./event-view";
import { FooterTrail } from "./footer";
import type { Keymap } from "./keymap";
import { type LiftedReader, LiftedReaderSheet } from "./lifted-reader";
import { BoardNav } from "./nav";
import { HelpSheet } from "./overlay";
import { Paging } from "./paging";
import type { ActivityCard, ActivitySource, CardHeader } from "./ports";
import { PromptPanel } from "./prompt-field";
import { SettingsOverlay } from "./settings-overlay";
import { useSpinnerFrame } from "./spinner";
import { CardTabQuestion, PinnedQuestion, TabBar } from "./tab-bar";
import { DispatchLayer } from "./trigger-form-view";

// The renderables the reducer's effects reach into, which the views mount.
export type ScreenRefs = {
	// The detail view's and the event view's scrollbox, which the scroll keys move (`scroll`).
	scroll: RefObject<ScrollBoxRenderable | null>;
	// The board list's scrollbox, kept on the selected row as j/k move it off-screen.
	list: RefObject<ScrollBoxRenderable | null>;
	// The `?` sheet's scrollbox, which the scroll keys move while it is open (`helpScroll`).
	help: RefObject<ScrollBoxRenderable | null>;
	// The reader over the detail view, which j/k scroll and `[`/`]` move by heading.
	reader: RefObject<LiftedReader.Handle | null>;
	// The copilot's input. It OWNS its text; the reducer only ever pushes a whole new value at it
	// (a shortcut expansion, a recalled prompt, the clear after a send) through `copilotSetText`.
	input: RefObject<TextareaRenderable | null>;
	// The same input, opened as a prompt for a card's action or a typed answer.
	prompt: RefObject<TextareaRenderable | null>;
};

const SCREEN_EFFECTS = [
	"scroll",
	"reveal",
	"helpScroll",
	"readerScroll",
	"readerJump",
	"copilotSetText",
	"promptSetText",
] as const;
export type ScreenEffect = Extract<
	BoardNav.Effect,
	{ type: (typeof SCREEN_EFFECTS)[number] }
>;
export const isScreenEffect = BoardNav.effectsOf(SCREEN_EFFECTS);

/**
 * The screen's refs and the runner for the effects that reach into them. While the board view is
 * on screen, the selected row stays in view.
 */
export const useScreenRefs = (
	state: BoardNav.BoardState | null,
): { refs: ScreenRefs; runEffect: (effect: ScreenEffect) => void } => {
	const scroll = useRef<ScrollBoxRenderable | null>(null);
	const list = useRef<ScrollBoxRenderable | null>(null);
	const help = useRef<ScrollBoxRenderable | null>(null);
	const reader = useRef<LiftedReader.Handle | null>(null);
	const input = useRef<TextareaRenderable | null>(null);
	const prompt = useRef<TextareaRenderable | null>(null);

	// Whenever selection changes (j/k, mouse), scroll the minimum distance to reveal it. Each row box
	// carries id `row-<taskId>`, which scrollChildIntoView resolves.
	const selectedId = state?.view.type === "board" ? state.selectedId : null;
	useEffect(() => {
		if (selectedId) list.current?.scrollChildIntoView(`row-${selectedId}`);
	}, [selectedId]);

	// Each press on a checklist item brings its row into view, so `space` on one scrolled off by
	// the brief toggles it and shows it at once.
	const pressed = state?.checklist.pressed ?? null;
	useEffect(() => {
		if (pressed)
			scroll.current?.scrollChildIntoView(BoardChecklist.rowId(pressed.itemId));
	}, [pressed]);

	// A task's `now` coming on screen brings the checklist cursor's row into view; after that the
	// human's scrolls are left alone until it comes on screen again.
	const checklist = state ? BoardChecklist.onScreen(state) : null;
	const revealedFor = useRef<string | null>(null);
	useEffect(() => {
		const taskId = checklist?.taskId ?? null;
		if (checklist && taskId !== revealedFor.current)
			scroll.current?.scrollChildIntoView(checklist.rowId);
		revealedFor.current = taskId;
	});

	const runEffect = useCallback((effect: ScreenEffect): void => {
		switch (effect.type) {
			case "scroll":
				Paging.apply(scroll.current, effect);
				return;
			case "reveal":
				scroll.current?.scrollChildIntoView(effect.id);
				return;
			case "helpScroll":
				Paging.apply(help.current, effect);
				return;
			case "readerScroll":
				reader.current?.scroll(effect);
				return;
			case "readerJump":
				reader.current?.jump(effect.delta);
				return;
			case "copilotSetText":
				input.current?.setText(effect.text);
				return;
			case "promptSetText":
				prompt.current?.setText(effect.text);
		}
	}, []);
	return { refs: { scroll, list, help, reader, input, prompt }, runEffect };
};

export type ScreenProps = {
	state: BoardNav.BoardState;
	scope: BoardData.ScopeInfo | null;
	notice: BoardNav.Notice | null;
	// The tasks pointing at an external issue.
	linked: ReadonlySet<string>;
	// A host's own header for its cards, by card kind.
	headers?: Readonly<Record<string, CardHeader>>;
	log: CopilotLog.Log | null;
	// Host cards plus the copilot's, and the source that reads their events.
	activity: BoardActivity.ActivityMap;
	source: ActivitySource;
	// The open detail view's records.
	records: Result<BoardData.DetailRecords> | undefined;
	// What landed on its `now` tab that the human has not seen yet.
	fresh?: Fresh;
	refs: ScreenRefs;
	input: BoardInput;
	// The event view on a card's tab refreshes its card every second; the keys read the same card.
	onCard: (card: ActivityCard) => void;
};

// What a view gets beyond the screen's props: which keys are live, the card header on screen, and
// the pane it mounts between its content and its footer.
type ViewProps = ScreenProps & {
	keys: Keymap.Live;
	header: CardHeader | undefined;
	pane: ReactNode;
};

export const Screen = (props: ScreenProps): ReactNode => {
	const { state, activity, headers, linked } = props;
	const spinnerFrame = useSpinnerFrame(anyActivityRunning(activity));
	// The host's own header for the card whose tab is on screen, by its kind.
	const activeKind = activity.cards.find(
		(c) => c.id === state.tabs.active,
	)?.kind;
	const header = activeKind ? headers?.[activeKind] : undefined;
	// Which keys are live and what they can act on, once for the footer and the `?` sheet alike.
	const openTaskId = state.view.type === "detail" ? state.view.taskId : null;
	const lifted = useMemo(
		() => liftedOf(props.records, openTaskId),
		[props.records, openTaskId],
	);
	const keys: Keymap.Live = {
		context: BoardNav.keyContext(state),
		situation: BoardNav.keySituation(state, {
			linked,
			header: header !== undefined,
			events:
				openTaskId !== null &&
				BoardActivity.eventsCard(
					activity,
					openTaskId,
					BoardNav.taskById(state, openTaskId)?.shortId,
				) !== undefined,
			lifted: lifted.map((entry) => entry.title),
		}),
		host: CardTab.hints(state),
	};
	const view: ViewProps = {
		...props,
		keys,
		header,
		pane: <Pane {...props} spinnerFrame={spinnerFrame} />,
	};
	// Every view sits under the tab bar; the overlays float over whichever view is on screen. Every
	// footer in it ends on the copilot session's context reading, when there is one.
	return (
		<FooterTrail.Provider value={CopilotLog.usageLabel(props.log)}>
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<TabBar
					tabs={state.tabs}
					cards={activity.cards}
					spinnerFrame={spinnerFrame}
					onSelect={(id) => props.input.dispatchMouse({ type: "tab", id })}
				/>
				<box style={{ flexDirection: "column", flexGrow: 1 }}>
					{state.view.type === "events" ? (
						<EventsScreen {...view} />
					) : state.view.type === "detail" ? (
						<DetailScreen {...view} />
					) : (
						<BoardScreen {...view} />
					)}
				</box>
				{BoardNav.readerOpen(state) ? (
					<LiftedReaderSheet entries={lifted} handleRef={props.refs.reader} />
				) : null}
				<Overlay {...view} />
			</box>
		</FooterTrail.Provider>
	);
};

// The open task's lifted entries, newest of each kind, once its records are in.
const liftedOf = (
	records: Result<BoardData.DetailRecords> | undefined,
	taskId: string | null,
): DetailModel.LiftedEntry[] =>
	records?.ok && records.value.task.id === taskId
		? DetailModel.lifted(records.value)
		: [];

// The dispatch overlay floats over WHICHEVER view it opened on (it's a separate state field, not a
// view), so it renders inside the same full-screen wrapper it absolutely positions against. The `?`
// sheet is the same kind of thing, anchored at the bottom instead of centred.
const Overlay = ({ state, keys, refs, input }: ViewProps): ReactNode => {
	if (state.help)
		return (
			<HelpSheet
				context={BoardNav.sheetContext(state)}
				situation={keys.situation}
				scrollRef={refs.help}
				host={keys.host}
			/>
		);
	if (state.settings)
		return (
			<SettingsOverlay
				view={state.settings}
				onRow={(index) => input.dispatchMouse({ type: "settingsRow", index })}
			/>
		);
	if (!state.dispatch) return null;
	const { taskId } = state.dispatch;
	return (
		<DispatchLayer
			shortId={BoardNav.shortIdOf(BoardNav.taskById(state, taskId), taskId)}
			overlay={state.dispatch}
			onField={(index) => input.dispatchMouse({ type: "formField", index })}
		/>
	);
};

// The copilot's pane, and a prompt a card's tab or a banner opened, which sits where the copilot's
// panel would, above its row. The pane is always mounted — one row unfocused, the panel when focused
// — so the copilot is a place on screen rather than something that appears when summoned.
const Pane = ({
	state,
	scope,
	log,
	refs,
	input,
	spinnerFrame,
}: ScreenProps & { spinnerFrame: string }): ReactNode => {
	const opened = state.prompt.open;
	return (
		<>
			{opened ? (
				<PromptPanel
					title={opened.title}
					aim={opened.aim}
					placeholder={opened.placeholder}
					text={state.prompt.text}
					textareaRef={refs.prompt}
					onSubmit={input.submitPrompt}
					onContentChange={input.mirrorPromptText}
				/>
			) : null}
			<CopilotPane
				copilot={state.copilot}
				// Briefs are fetched on submit; the chip only needs the ids the state already holds.
				chip={contextChip(BoardContext.project(state, scope, new Map()))}
				focused={state.focus === "copilot"}
				log={log}
				spinnerFrame={spinnerFrame}
				detailShownElsewhere={
					state.view.type === "events" &&
					state.view.cardId === CopilotLog.CARD_ID
				}
				outranked={BoardNav.copilotOutranked(state)}
				askInHand={BoardNav.askInHand(state)}
				reach={BoardNav.askReach(state)}
				textareaRef={refs.input}
				onSubmit={input.submitCopilot}
				onContentChange={input.mirrorCopilotText}
				onFormSubmit={input.submitForm}
				onAsk={input.dispatchMouse}
			/>
		</>
	);
};

// A card's events: its own tab, or the copilot's transcript.
const EventsScreen = ({
	state,
	notice,
	log,
	activity,
	source,
	refs,
	input,
	onCard,
	keys,
	header,
	pane,
}: ViewProps): ReactNode => {
	if (state.view.type !== "events") return null;
	const { cardId } = state.view;
	const { tabs } = state;
	const transcript = cardId === CopilotLog.CARD_ID;
	// Resolve task ULID → shortId from loaded sections (for the event view's header).
	const resolveShortId = (taskId: string): string | undefined => {
		const task = BoardNav.taskById(state, taskId);
		return task ? BoardNav.shortIdOf(task, task.id) : undefined;
	};
	return (
		<EventView
			// One view per card: switching tabs remounts it on the other card's events.
			key={cardId}
			cardId={cardId}
			initialCard={activity.cards.find((c) => c.id === cardId)}
			source={source}
			resolveShortId={resolveShortId}
			scrollRef={refs.scroll}
			notice={notice}
			plan={transcript ? log?.current.plan : undefined}
			// The transcript draws a permission at the head of the queue; a form there is the
			// pane's to draw, since it takes the keys.
			permissions={
				transcript && state.copilot.asks[0]?.type === "permission"
					? state.copilot.asks.flatMap((ask) =>
							ask.type === "permission" ? [ask.request] : [],
						)
					: undefined
			}
			onAsk={input.dispatchMouse}
			tabbed={tabs.active === cardId}
			lane={CardTab.view(tabs, cardId).lane}
			onLane={(index) => input.dispatchMouse({ type: "lane", index })}
			onCard={onCard}
			header={tabs.active === cardId ? header : undefined}
			expanded={CardTab.view(tabs, cardId).expanded}
			toolDetails={state.view.toolDetails ?? false}
			// On a card's own tab, the question its sessions wait on, answered in place.
			banner={
				<CardTabQuestion
					tabs={tabs}
					onAnswer={(index) => input.dispatchMouse({ type: "answer", index })}
				/>
			}
			keys={keys}
			pane={pane}
		/>
	);
};

// The decision the detail view asks under its header, or, while a session's question pinned over the
// view has the keys, the row that says decisions wait.
const DecisionSlot = ({
	state,
	input,
}: Pick<ViewProps, "state" | "input">): ReactNode => {
	const asked = BoardDecisions.shown(state);
	if (!asked) {
		const count = BoardDecisions.waiting(state);
		return count > 0 ? <DecisionsWaiting count={count} /> : null;
	}
	return (
		<DecisionPanel
			// One block per decision, and a fresh one once `esc` starts it over: a new one opens on its
			// first field, its input empty.
			key={`${asked.decision.id}#${String(asked.started)}`}
			asked={asked}
			inHand={BoardDecisions.keysInHand(state)}
			reach={BoardDecisions.reach(state)}
			onSubmit={input.submitDecision}
			onPick={(index) => input.dispatchMouse({ type: "decisionOption", index })}
			onKey={(name) => input.dispatchMouse({ type: "decisionKey", name })}
			onReach={() => input.dispatchMouse({ type: "decisionReach" })}
		/>
	);
};

// A task's detail, under the question pinned over it.
const DetailScreen = ({
	state,
	notice,
	linked,
	activity,
	records,
	fresh,
	refs,
	input,
	keys,
	pane,
}: ViewProps): ReactNode => {
	if (state.view.type !== "detail") return null;
	const { taskId, banner } = state.view;
	const task = BoardNav.taskById(state, taskId);
	const taskCards = BoardActivity.cardsForTask(activity, taskId, task?.shortId);
	return (
		<>
			<PinnedQuestion
				tabs={state.tabs}
				banner={banner}
				cards={activity.cards}
				onAnswer={(index) => input.dispatchMouse({ type: "answer", index })}
			/>
			<Detail
				taskId={taskId}
				task={task}
				records={records}
				fresh={fresh}
				covered={
					BoardNav.readerOpen(state) ||
					state.help ||
					state.settings !== null ||
					state.dispatch !== null
				}
				cards={taskCards.length > 0 ? taskCards : undefined}
				questions={activity.questionsByTaskId.get(taskId)}
				pinned={banner?.question.questionActivityId}
				tab={BoardNav.detailTab(state.view)}
				onTab={(tab) => input.dispatchMouse({ type: "detailTab", tab })}
				scrollRef={refs.scroll}
				notice={notice}
				focus={state.focus}
				pane={pane}
				linked={linked.has(taskId)}
				keys={keys}
				onCopy={() => input.dispatchMouse({ type: "copy" })}
				decision={<DecisionSlot state={state} input={input} />}
				checklist={BoardChecklist.shown(state)}
				onItem={(id) => input.dispatchMouse({ type: "checklistItem", id })}
				onOpenTask={(id) =>
					input.dispatchMouse({ type: "openTask", taskId: id })
				}
			/>
		</>
	);
};

// The board's list of sections.
const BoardScreen = ({
	state,
	scope,
	notice,
	linked,
	log,
	activity,
	refs,
	input,
	keys,
	pane,
}: ViewProps): ReactNode => (
	<Board
		sections={state.sections}
		expanded={state.expanded}
		selectedId={state.selectedId}
		search={state.search}
		activity={activity}
		scopeLabel={state.scoped && scope ? scope.label : "all scopes"}
		kind={state.kind}
		status={state.status}
		decisions={state.decisions}
		progress={state.checklist.progress}
		marked={state.marked}
		// The reload after each of the copilot's writes is what puts the fresh `updatedBy`
		// and `updatedAt` in hand; the reducer decides which of them the glyph is for.
		touched={BoardNav.copilotTouched(state, log?.current.card.startedAt)}
		linked={linked}
		keys={keys}
		scrollRef={refs.list}
		onSelect={(row) => input.dispatchMouse({ type: "select", row })}
		onToggle={(row) => input.dispatchMouse({ type: "toggleExpand", row })}
		notice={notice}
		focus={state.focus}
		pane={pane}
		announcement={state.announcement}
		onDismissAnnouncement={() => input.dispatchMouse({ type: "announcement" })}
	/>
);
