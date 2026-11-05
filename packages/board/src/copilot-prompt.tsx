/** @jsxImportSource @opentui/react */
// The copilot pane, pinned above the footer, at one of two sizes. Unfocused it is a single status
// row — the turn's progress through its own plan, or an invitation. Focused it opens into the
// panel: the plan with live ticks, the agent's last lines, and a real multi-line input.
//
// The input is OpenTUI's `<textarea>`, which owns the buffer and every editing key — paste, word
// motions, ctrl+w, undo, home/end — none of which the hand-rolled prompt had. That splits ownership,
// so the rule is: THE TEXTAREA IS THE SOURCE OF TRUTH for the text; `copilot.text` mirrors it
// through onContentChange so the reducer can match `/` shortcuts against it; and text only flows
// back INTO the textarea imperatively (expanding a shortcut, recalling history, clearing on send)
// through the ref app.tsx holds.
//
// Key arbitration: a focused textarea and the app's one useKeyboard handler BOTH receive every key,
// global first. app.tsx calls preventDefault for exactly the keys BoardNav.copilotConsumes names, so
// those reach the reducer alone and everything else is the textarea's.
import type { TextareaRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import type { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { elapsed } from "./elapsed";
import { ElicitationBlock, elicitationSegments } from "./elicitation-block";
import { copilotIndicatorFg } from "./footer";
import { BoardNav } from "./nav";
import {
	outrankedSegments,
	PermissionBlock,
	permissionSegments,
} from "./permission-block";
import { PlanBlock } from "./plan-block";
import type { PlanEntry } from "./ports";
import { fieldRows, PromptField } from "./prompt-field";
import { Segments } from "./segments";
import { type Theme, useTheme } from "./theme";

const PLACEHOLDER = "ask about the selection · / for shortcuts";
// One turn at a time, so while one runs `submitCopilot` refuses to send and flashes instead. The
// input must not go on inviting what it cannot do — and the draft IS kept, so this says when it
// will go rather than that it is lost.
const RUNNING_PLACEHOLDER = "a turn is running · send when it ends";

// The chip text: the selected task, the working-set size, the section — whichever apply, in that
// order. Exported pure so the copy is assertable without a renderer.
export const contextChip = (ctx: BoardContext.Context): string => {
	const parts: string[] = [];
	if (ctx.selected) parts.push(ctx.selected.shortId);
	if (ctx.marked.length > 0) parts.push(`${ctx.marked.length} marked`);
	if (ctx.section) parts.push(ctx.section);
	return parts.length > 0 ? parts.join(" · ") : "no selection";
};

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

// The harness the copilot runs as, from the actor its writes are stamped with:
// `cabane://actor/agent/claude` → `claude`. Null when the host gave no actor.
export const harnessOf = (actor: string | null): string | null =>
	actor?.split("/").at(-1) || null;

type TurnState = "running" | "stopped" | "done" | "";

const turnState = (turn: BoardNav.CopilotState["turn"]): TurnState =>
	turn === "running"
		? "running"
		: turn === "error"
			? "stopped"
			: turn === "done"
				? "done"
				: "";

const stateFg = (state: TurnState, theme: Theme.Tokens): string =>
	state === "running"
		? theme.working
		: state === "stopped"
			? theme.failed
			: state === "done"
				? theme.done
				: theme.muted;

/**
 * The panel's first row: `copilot · claude · JALL-1 · next · 1/3 · running · 12s`. `copilot` is the
 * panel's Label, bold in the text color; the harness is the one name in the text color, the rest is
 * muted chrome, and the turn's state takes its hue. Exported pure so the copy and its colors are
 * assertable without a renderer.
 */
export const titleSegments = (
	parts: {
		harness: string | null;
		chip: string;
		progress: string | null;
		state: TurnState;
		elapsed: string | null;
	},
	theme: Theme.Tokens,
): Segments.Segment[] => {
	const sep = { text: " · ", fg: theme.muted };
	return [
		{ text: "copilot", fg: theme.text, attributes: TextAttributes.BOLD },
		...(parts.harness ? [sep, { text: parts.harness, fg: theme.text }] : []),
		sep,
		{ text: parts.chip, fg: theme.muted },
		...(parts.progress ? [sep, { text: parts.progress, fg: theme.muted }] : []),
		...(parts.state
			? [sep, { text: parts.state, fg: stateFg(parts.state, theme) }]
			: []),
		...(parts.elapsed ? [sep, { text: parts.elapsed, fg: theme.muted }] : []),
	];
};

// The palette's name column, sized to the longest name on offer: `› /setup-dispatch` must never run
// into its own expansion. The gutter, the slash and a two-cell gap are the chrome around the name.
// A harness's skills can be named at length, so the column stops at half the row and a name past
// it is cut, leaving the hint its room.
export const paletteNameCols = (
	entries: readonly BoardNav.PaletteEntry[],
	width: number,
): number =>
	Math.min(
		Math.max(0, ...entries.map((entry) => entry.name.length)) + 5,
		Math.max(12, Math.floor(width / 2)),
	);

// How many rows the plan, the agent's last lines and the palette may take above the input. The
// harness's commands and skills can run to dozens, and the board has to stay in view behind them.
const MAX_PLAN_ROWS = 6;
const MAX_TAIL_ROWS = 3;
const MAX_PALETTE_ROWS = 8;

// An ask is the one thing in the pane waiting on the human, so its panel earns the space: a third
// of the terminal and never under ASK_MIN_ROWS, growing with what it asks up to half, so the board
// stays in view behind it. On a short terminal the half wins and the minimum gives way.
const ASK_MIN_ROWS = 12;

/**
 * The rows the panel holding an ask takes on a terminal `termRows` tall, its padding included. The
 * cap is not a clip: a form fits itself under it (ElicitationBlock's `rows`), and one that cannot
 * even at its tightest takes the rows it needs rather than drawing its rows over each other.
 */
export const askPanelRows = (
	termRows: number,
): { min: number; max: number } => {
	const max = Math.floor(termRows / 2);
	return {
		min: Math.min(max, Math.max(ASK_MIN_ROWS, Math.ceil(termRows / 3))),
		max,
	};
};

// The ask panel's surface: a blank row above its title and below its last row, so it reads as a
// panel and not as a strip on the bottom edge, its content at the top of the height it holds.
const askPanelStyle = (termRows: number) => ({
	paddingTop: 1,
	paddingBottom: 1,
	minHeight: askPanelRows(termRows).min,
});

/**
 * The first of the `rows` palette entries on screen out of `count`: the window keeps the pick in
 * its middle, and stops at either end of the list.
 */
export const paletteStart = (
	count: number,
	picked: number,
	rows: number,
): number => Math.max(0, Math.min(picked - Math.floor(rows / 2), count - rows));

export type CopilotPaneProps = {
	copilot: BoardNav.CopilotState;
	chip: string;
	focused: boolean;
	// The session's turns, for the plan and the agent's last lines. Always the CURRENT one: the
	// panel is the live surface, and the turns behind it are read in the transcript. Null before the
	// first prompt.
	log: CopilotLog.Log | null;
	spinnerFrame: string;
	// True when another surface on screen already owns this turn's detail — the transcript, open on
	// the copilot's own card, which pins the same plan and heads with the same status. The pane then
	// contributes nothing but its input: no status row, no plan, no second thing animating.
	detailShownElsewhere?: boolean;
	// A session question on the view holds the answer keys (BoardNav.copilotOutranked): the row
	// names the copilot's request and how to reach it instead of offering keys that go elsewhere.
	outranked?: boolean;
	// The harness's oldest request has the keys (BoardNav.askInHand), so a form's input may take them.
	askInHand?: boolean;
	// While it does not, who has them and the key that hands them over (BoardNav.askReach), said in
	// place of answer keys that would go elsewhere. Outranked with none given, it is `tab`.
	reach?: BoardNav.AskReach;
	textareaRef: RefObject<TextareaRenderable | null>;
	onSubmit: () => void;
	onContentChange: () => void;
	// `enter` in a form's input, with what it holds.
	onFormSubmit?: (text: string) => void;
	// A click on the ask: an answer, a hint, or the collapsed row naming it.
	onAsk?: (click: BoardNav.AskClick) => void;
};

export const CopilotPane = ({
	copilot,
	chip,
	focused,
	log,
	spinnerFrame,
	detailShownElsewhere = false,
	outranked = false,
	askInHand = false,
	reach: given,
	textareaRef,
	onSubmit,
	onContentChange,
	onFormSubmit = () => {},
	onAsk,
}: CopilotPaneProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	// A raised panel with no frame of its own: herdr draws the lines, and the accent is kept for the
	// cursor, the one thing in the pane that is waiting on you. The input is a field one step up, the
	// width of the pane, so it reads as the place to type and not as more footer under the footer.
	const paneBg = theme.surface.raised;
	// Columns inside the panel's one cell of padding either side.
	const inner = width - 2;
	const running = copilot.turn === "running";
	const plan = log?.current.plan ?? [];
	const progress = plan.length > 0 ? planProgress(plan) : null;
	const [asking, ...queued] = copilot.asks;
	const reach = given ?? (outranked ? { key: "tab" } : undefined);
	const onReach = onAsk && (() => onAsk({ type: "askReach" }));
	const title = (): Segments.Segment[] =>
		titleSegments(paneTitle(copilot, chip, log, progress), theme);

	// A form is the one request no other surface draws: it opens the panel, focused or not, over the
	// transcript too, in place of the input it would otherwise compete with for the keys. Outranked,
	// the one row names it and the key that reaches it.
	if (asking?.type === "elicitation" && !outranked)
		return (
			<FormPanel
				ask={asking}
				waiting={queued.length}
				title={title()}
				inHand={askInHand}
				reach={reach}
				onSubmit={onFormSubmit}
				{...clicks(onAsk)}
				onReach={onReach}
			/>
		);

	// Nothing left to add: the transcript is showing all of it.
	if (!focused && detailShownElsewhere) return null;

	if (!focused)
		return (
			<CollapsedRow
				copilot={copilot}
				log={log}
				spinnerFrame={spinnerFrame}
				width={width}
				reach={reach}
				onReach={onReach}
			/>
		);

	const matches = BoardNav.matchingShortcuts(
		BoardNav.paletteEntries(copilot),
		copilot.text,
	);
	const tail = (log?.current.tail ?? []).slice(-MAX_TAIL_ROWS);
	// A blocked harness outranks everything else the panel could say: the turn is not going anywhere
	// until it is answered, so the plan and the palette wait.
	const showChoice = asking !== undefined && !detailShownElsewhere;
	// A shortcut palette replaces the plan while one is being picked: both at once is noise, and the
	// human typing `/` is not watching the todo.
	const showPalette = !showChoice && matches.length > 0;
	const showPlan =
		!showChoice && !showPalette && !detailShownElsewhere && plan.length > 0;
	const showTail =
		!showChoice && !showPalette && !detailShownElsewhere && tail.length > 0;

	const asksPermission = showChoice && asking?.type === "permission";
	return (
		<box
			style={{
				flexShrink: 0,
				flexDirection: "column",
				backgroundColor: paneBg,
				...(asksPermission ? askPanelStyle(height) : {}),
			}}
		>
			<box style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
				<text bg={paneBg}>{Segments.spans(Segments.fit(title(), inner))}</text>
				{asksPermission ? (
					<PermissionBlock
						request={asking.request}
						waiting={queued.length}
						width={inner}
						bg={paneBg}
						{...clicks(onAsk)}
					/>
				) : null}
				{showPlan ? (
					<PlanBlock
						plan={plan}
						spinnerFrame={spinnerFrame}
						// An entry's text, less the glyph and the space before it.
						width={inner - 2}
						maxRows={MAX_PLAN_ROWS}
						bg={paneBg}
					/>
				) : null}
				{showTail
					? tail.map((line, index) => (
							// Index keys: a positional window on the last few lines, not a list of things — row N is its only identity, and the same line can legitimately repeat.
							<text key={index} bg={paneBg} fg={theme.muted}>
								{fit(line, inner)}
							</text>
						))
					: null}
				{showPalette ? (
					<Palette
						entries={matches}
						paletteAt={copilot.paletteAt}
						width={inner}
					/>
				) : null}
			</box>
			<PromptField
				textareaRef={textareaRef}
				// The textarea unmounts with the panel, so the mirror seeds the new one: a draft
				// survives tabbing to the board to mark rows and tabbing back.
				initialValue={copilot.text}
				placeholder={running ? RUNNING_PLACEHOLDER : PLACEHOLDER}
				rows={fieldRows(copilot.text, height)}
				onSubmit={onSubmit}
				onContentChange={onContentChange}
			/>
		</box>
	);
};

// What the panel's title row says about the turn in hand.
const paneTitle = (
	copilot: BoardNav.CopilotState,
	chip: string,
	log: CopilotLog.Log | null,
	progress: string | null,
): Parameters<typeof titleSegments>[0] => ({
	harness: harnessOf(copilot.actor),
	chip,
	progress,
	state: turnState(copilot.turn),
	elapsed: log
		? elapsed(log.current.card.startedAt, log.current.card.finishedAt)
		: null,
});

// An ask block's click props, from the pane's one handler: none when it has none.
const clicks = (
	onAsk: ((click: BoardNav.AskClick) => void) | undefined,
): { onPick?: (index: number) => void; onKey?: (name: string) => void } =>
	onAsk
		? {
				onPick: (index) => onAsk({ type: "askOption", index }),
				onKey: (name) => onAsk({ type: "askKey", name }),
			}
		: {};

// The panel a form opens: the pane's title row over the form, and nothing to type a prompt into.
const FormPanel = ({
	ask,
	waiting,
	title,
	inHand,
	reach,
	onSubmit,
	onPick,
	onKey,
	onReach,
}: {
	ask: Extract<BoardNav.CopilotAsk, { type: "elicitation" }>;
	waiting: number;
	title: Segments.Segment[];
	inHand: boolean;
	reach: BoardNav.AskReach | undefined;
	onSubmit: (text: string) => void;
	onPick?: (index: number) => void;
	onKey?: (name: string) => void;
	onReach?: () => void;
}): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const paneBg = theme.surface.raised;
	const inner = width - 2;
	return (
		<box
			style={{
				flexShrink: 0,
				flexDirection: "column",
				backgroundColor: paneBg,
				paddingLeft: 1,
				paddingRight: 1,
				...askPanelStyle(height),
			}}
		>
			<text bg={paneBg}>{Segments.spans(Segments.fit(title, inner))}</text>
			<ElicitationBlock
				request={ask.request}
				draft={ask.draft}
				waiting={waiting}
				width={inner}
				// Inside the cap, less the padding and the title row.
				rows={askPanelRows(height).max - 3}
				bg={paneBg}
				inHand={inHand}
				reach={reach}
				onSubmit={onSubmit}
				onPick={onPick}
				onKey={onKey}
				onReach={onReach}
			/>
		</box>
	);
};

const planProgress = (plan: readonly PlanEntry[]): string =>
	`${plan.filter((entry) => entry.status === "completed").length}/${plan.length}`;

// The palette's window on what matches: the rows around the pick, and where they sit in a list
// longer than the window.
const Palette = ({
	entries,
	paletteAt,
	width,
}: {
	entries: readonly BoardNav.PaletteEntry[];
	paletteAt: number;
	width: number;
}): ReactNode => {
	const theme = useTheme();
	// Clamped here as well as in the reducer: the list shrinks as the name is typed, and a render
	// between the two would otherwise point past the end of it.
	const selected = Math.min(
		Math.max(paletteAt, 0),
		Math.max(0, entries.length - 1),
	);
	const nameCols = paletteNameCols(entries, width);
	const from = paletteStart(entries.length, selected, MAX_PALETTE_ROWS);
	const shown = entries.slice(from, from + MAX_PALETTE_ROWS);
	return (
		<>
			{shown.map((entry, index) => (
				<PaletteRow
					key={`${entry.source ?? ""}/${entry.name}`}
					entry={entry}
					picked={from + index === selected}
					nameCols={nameCols}
					width={width}
				/>
			))}
			{shown.length < entries.length ? (
				<text bg={theme.surface.raised} fg={theme.muted}>
					{`  ${from + 1}–${from + shown.length} of ${entries.length}`}
				</text>
			) : null}
		</>
	);
};

// One `/` entry: its name in the text color and its expansion muted, so the list reads as the
// repertoire it is; a harness command leads its hint with the harness's name, since the board does
// not run it. ↑/↓ move the pick, which paints the selected surface across the whole row (the
// Selection Rule); the `›` gutter says which one enter and tab will take. Not the input's `▸`:
// stacked directly above it, the same glyph made the picked row read as another prompt.
const PaletteRow = ({
	entry,
	picked,
	nameCols,
	width,
}: {
	entry: BoardNav.PaletteEntry;
	picked: boolean;
	nameCols: number;
	width: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = picked ? theme.surface.selected : theme.surface.raised;
	const name =
		`${picked ? "› " : "  "}${fit(`/${entry.name}`, nameCols - 4)}`.padEnd(
			nameCols,
		);
	const hint = fit(
		entry.source ? `${entry.source} · ${entry.hint}` : entry.hint,
		Math.max(0, width - nameCols),
	);
	return (
		<text bg={bg}>
			<span fg={picked ? theme.accent : theme.muted}>{name.slice(0, 2)}</span>
			<span fg={theme.text}>{name.slice(2)}</span>
			<span fg={theme.muted}>{hint.padEnd(width - nameCols)}</span>
		</text>
	);
};

// The one-row form: what the turn is doing, or how to start one. Padded to full width so the row is
// owned the way the footer's is.
const CollapsedRow = ({
	copilot,
	log,
	spinnerFrame,
	width,
	reach,
	onReach,
}: {
	copilot: BoardNav.CopilotState;
	log: CopilotLog.Log | null;
	spinnerFrame: string;
	width: number;
	reach: BoardNav.AskReach | undefined;
	// A click on the row while it names an ask: what holds the keys hands them over, or the copilot
	// takes them and opens it.
	onReach?: () => void;
}): ReactNode => {
	const status =
		copilot.turn === "idle" || !log
			? null
			: CopilotLog.footer(log, spinnerFrame);
	const theme = useTheme();
	const paneBg = theme.surface.raised;
	const line = Segments.fit(
		collapsedSegments(copilot, log, status, theme, reach),
		width,
	);
	const used = Segments.plain(line).length;
	return (
		<box style={{ flexShrink: 0, height: 1, backgroundColor: paneBg }}>
			<text
				bg={paneBg}
				onMouseDown={copilot.asks.length > 0 ? onReach : undefined}
			>
				{Segments.spans(line)}
				{" ".repeat(Math.max(0, width - used))}
			</text>
		</box>
	);
};

// What the one row says, in priority order. This row is where a board with no transcript open
// learns that something is waiting on it — the pane is the only copilot surface present in every
// view — so a question outranks the progress it would otherwise report: the progress has stopped.
//
// `o transcript` rides along wherever there is one to open. The board's footer is deliberately
// trimmed to the board's own keys, which left the key the human reaches for right after sending a
// prompt named nowhere on screen; this row is the place that fits, because it is the one they are
// already reading. A pending question is the exception — it has its own answer keys to name.
//
// Keys read as the footer's do: the key in the text color, what it does muted. The turn's own status
// keeps the indicator's color, the same one the footer gives it.
export const collapsedSegments = (
	copilot: BoardNav.CopilotState,
	log: CopilotLog.Log | null,
	status: CopilotLog.Footer | null,
	theme: Theme.Tokens,
	reach?: BoardNav.AskReach,
): Segments.Segment[] => {
	const [asking, ...queued] = copilot.asks;
	if (asking && reach)
		return outrankedSegments(
			asking.type === "permission"
				? asking.request.title
				: asking.request.message,
			theme,
			theme.text,
			queued.length,
			reach.key,
		);
	if (asking?.type === "permission")
		return permissionSegments(asking.request, theme, theme.text, queued.length);
	if (asking)
		return elicitationSegments(
			asking.request,
			theme,
			theme.text,
			queued.length,
		);
	const transcript: Segments.Segment[] = log
		? [
				{ text: " · ", fg: theme.muted },
				{ text: "o", fg: theme.text },
				{ text: " transcript", fg: theme.muted },
			]
		: [];
	if (log && status)
		return [
			{
				text: planLine(log, status),
				fg: copilotIndicatorFg(status.tone, theme),
			},
			...transcript,
		];
	const draft: Segments.Segment[] = copilot.text
		? [
				{ text: " · draft: ", fg: theme.muted },
				{ text: copilot.text.split("\n")[0] ?? "", fg: theme.text },
			]
		: [];
	return [
		{ text: "▸ ", fg: theme.muted },
		{ text: "tab", fg: theme.text },
		{ text: " to ask the copilot", fg: theme.muted },
		...draft,
		...transcript,
	];
};

// A running turn says which plan entry it is on — the agent's own words beat the tool name. A
// finished one keeps the footer's wording, which the tests already pin.
const planLine = (log: CopilotLog.Log, status: CopilotLog.Footer): string => {
	if (status.tone !== "running") return status.text;
	const entry = log.current.plan.find((e) => e.status === "in_progress");
	return entry
		? status.text.replace(log.current.activity, entry.content)
		: status.text;
};
