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
import { defaultTextareaKeyBindings } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import type { BoardContext } from "./context";
import { CopilotLog } from "./copilot-log";
import { elapsed } from "./elapsed";
import { copilotIndicatorFg } from "./footer";
import { BoardNav } from "./nav";
import { PermissionBlock, permissionSegments } from "./permission-block";
import { PlanBlock } from "./plan-block";
import type { CopilotShortcut, PlanEntry } from "./ports";
import { Segments } from "./segments";
import { type Theme, useTheme } from "./theme";

// Enter sends — the common case by far. A newline is ⇧enter where the terminal reports it and
// ctrl+j everywhere (⇧enter needs the kitty keyboard protocol; ctrl+j is plain ASCII LF).
export const INPUT_KEY_BINDINGS = [
	...defaultTextareaKeyBindings.filter(
		(binding) => binding.action !== "newline" && binding.action !== "submit",
	),
	{ name: "return", action: "submit" as const },
	{ name: "kpenter", action: "submit" as const },
	{ name: "return", shift: true, action: "newline" as const },
	{ name: "j", ctrl: true, action: "newline" as const },
];

export const PLACEHOLDER = "ask about the selection · / for shortcuts";
// One turn at a time, so while one runs `submitCopilot` refuses to send and flashes instead. The
// input must not go on inviting what it cannot do — and the draft IS kept, so this says when it
// will go rather than that it is lost.
export const RUNNING_PLACEHOLDER = "a turn is running · send when it ends";

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
 * The panel's first row: `copilot · claude · JALL-1 · next · 1/3 · running · 12s`. Chrome is muted;
 * the harness is the one name in the text color, and the turn's state takes its hue. Exported pure so
 * the copy and its colors are assertable without a renderer.
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
		{ text: "copilot", fg: theme.muted },
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
export const paletteNameCols = (
	shortcuts: readonly CopilotShortcut[],
): number =>
	Math.max(0, ...shortcuts.map((shortcut) => shortcut.name.length)) + 5;

// How many rows the panel may take: enough to be useful, never enough to bury the board. The input
// keeps its floor even on a short terminal — a one-row input is what this pane exists to replace.
const MIN_INPUT_ROWS = 3;
const MAX_INPUT_ROWS = 8;
const MAX_PLAN_ROWS = 6;
const MAX_TAIL_ROWS = 3;

export const inputRows = (text: string, termRows: number): number => {
	const typed = text === "" ? 1 : text.split("\n").length;
	const room = Math.max(MIN_INPUT_ROWS, Math.floor(termRows * 0.25));
	return Math.min(Math.max(MIN_INPUT_ROWS, typed), MAX_INPUT_ROWS, room);
};

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
	textareaRef: RefObject<TextareaRenderable | null>;
	onSubmit: () => void;
	onContentChange: () => void;
};

export const CopilotPane = ({
	copilot,
	chip,
	focused,
	log,
	spinnerFrame,
	detailShownElsewhere = false,
	textareaRef,
	onSubmit,
	onContentChange,
}: CopilotPaneProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	// A raised panel with no frame of its own: herdr draws the lines, and the accent is kept for the
	// cursor, the one thing in the pane that is waiting on you.
	const paneBg = theme.surface.raised;
	// Columns inside the panel's one cell of padding either side.
	const inner = width - 2;
	const running = copilot.turn === "running";
	const plan = log?.current.plan ?? [];
	const progress = plan.length > 0 ? planProgress(plan) : null;

	// Nothing left to add: the transcript is showing all of it.
	if (!focused && detailShownElsewhere) return null;

	if (!focused) {
		return (
			<CollapsedRow
				copilot={copilot}
				log={log}
				spinnerFrame={spinnerFrame}
				width={width}
			/>
		);
	}

	const matches = BoardNav.matchingShortcuts(copilot.shortcuts, copilot.text);
	// Clamped here as well as in the reducer: the list shrinks as the name is typed, and a render
	// between the two would otherwise point past the end of it.
	const selected = Math.min(
		Math.max(copilot.paletteAt, 0),
		Math.max(0, matches.length - 1),
	);
	const tail = (log?.current.tail ?? []).slice(-MAX_TAIL_ROWS);
	const rows = inputRows(copilot.text, height);
	// A blocked harness outranks everything else the panel could say: the turn is not going anywhere
	// until it is answered, so the plan and the palette wait.
	const showChoice = copilot.permission !== null && !detailShownElsewhere;
	// A shortcut palette replaces the plan while one is being picked: both at once is noise, and the
	// human typing `/` is not watching the todo.
	const showPalette = !showChoice && matches.length > 0;
	const showPlan =
		!showChoice && !showPalette && !detailShownElsewhere && plan.length > 0;
	const showTail =
		!showChoice && !showPalette && !detailShownElsewhere && tail.length > 0;
	const title = titleSegments(
		{
			harness: harnessOf(copilot.actor),
			chip,
			progress,
			state: turnState(copilot.turn),
			elapsed: log
				? elapsed(log.current.card.startedAt, log.current.card.finishedAt)
				: null,
		},
		theme,
	);
	const nameCols = paletteNameCols(matches);

	return (
		<box
			style={{
				flexShrink: 0,
				flexDirection: "column",
				backgroundColor: paneBg,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={paneBg}>{Segments.spans(Segments.fit(title, inner))}</text>
			{showChoice && copilot.permission ? (
				<PermissionBlock
					request={copilot.permission}
					width={inner - 4}
					bg={paneBg}
				/>
			) : null}
			{showPlan ? (
				<PlanBlock
					plan={plan}
					spinnerFrame={spinnerFrame}
					width={inner - 4}
					maxRows={MAX_PLAN_ROWS}
					bg={paneBg}
				/>
			) : null}
			{showTail
				? tail.map((line, index) => (
						// Index keys: a positional window on the last few lines, not a list of things — row N is its only identity, and the same line can legitimately repeat.
						<text key={index} bg={paneBg} fg={theme.muted}>
							{fit(line, inner - 2)}
						</text>
					))
				: null}
			{showPalette
				? matches.map((shortcut, index) => (
						<PaletteRow
							key={shortcut.name}
							shortcut={shortcut}
							picked={index === selected}
							nameCols={nameCols}
							width={inner}
						/>
					))
				: null}
			<box style={{ flexDirection: "row", height: rows }}>
				<text bg={paneBg} fg={theme.muted}>
					▸{" "}
				</text>
				<textarea
					ref={textareaRef}
					focused
					keyBindings={INPUT_KEY_BINDINGS}
					// The textarea unmounts with the panel, so the mirror seeds the new one: a draft
					// survives tabbing to the board to mark rows and tabbing back. Applied once, on
					// creation — after that the textarea is the source of truth again.
					initialValue={copilot.text}
					placeholder={running ? RUNNING_PLACEHOLDER : PLACEHOLDER}
					placeholderColor={theme.muted}
					backgroundColor={paneBg}
					focusedBackgroundColor={paneBg}
					textColor={theme.text}
					focusedTextColor={theme.text}
					cursorColor={theme.accent}
					wrapMode="word"
					onSubmit={onSubmit}
					onContentChange={onContentChange}
					style={{ flexGrow: 1, height: rows }}
				/>
			</box>
		</box>
	);
};

const planProgress = (plan: readonly PlanEntry[]): string =>
	`${plan.filter((entry) => entry.status === "completed").length}/${plan.length}`;

// One `/` shortcut: its name in the text color and its expansion muted, so the list reads as the
// repertoire it is. ↑/↓ move the pick, which paints the selected surface across the whole row (the
// Selection Rule); the `›` gutter says which one enter and tab will take. Not the input's `▸`:
// stacked directly above it, the same glyph made the picked row read as another prompt.
const PaletteRow = ({
	shortcut,
	picked,
	nameCols,
	width,
}: {
	shortcut: CopilotShortcut;
	picked: boolean;
	nameCols: number;
	width: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = picked ? theme.surface.selected : theme.surface.raised;
	const name = `${picked ? "› " : "  "}/${shortcut.name}`.padEnd(nameCols);
	const hint = fit(shortcut.hint, Math.max(0, width - nameCols));
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
}: {
	copilot: BoardNav.CopilotState;
	log: CopilotLog.Log | null;
	spinnerFrame: string;
	width: number;
}): ReactNode => {
	const status =
		copilot.turn === "idle" || !log
			? null
			: CopilotLog.footer(log, spinnerFrame);
	const theme = useTheme();
	const paneBg = theme.surface.raised;
	const line = Segments.fit(
		collapsedSegments(copilot, log, status, theme),
		width,
	);
	const used = Segments.plain(line).length;
	return (
		<box style={{ flexShrink: 0, height: 1, backgroundColor: paneBg }}>
			<text bg={paneBg}>
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
): Segments.Segment[] => {
	if (copilot.permission)
		return permissionSegments(copilot.permission, theme, theme.text);
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
