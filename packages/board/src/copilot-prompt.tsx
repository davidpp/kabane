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
import type { PlanEntry } from "./ports";

const CHIP_COLOR = "#f97316";
const MUTED_COLOR = "#6b7280";
const TEXT_COLOR = "#e6edf3";
const DONE_COLOR = "#22c55e";
const PANE_BG = "#1c1c1c";

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

// The chip text: the selected task, the working-set size, the section — whichever apply, in that
// order. Exported pure so the copy is assertable without a renderer.
export const contextChip = (ctx: BoardContext.Context): string => {
	const parts: string[] = [];
	if (ctx.selected) parts.push(ctx.selected.shortId);
	if (ctx.marked.length > 0) parts.push(`${ctx.marked.length} marked`);
	if (ctx.section) parts.push(ctx.section);
	return parts.length > 0 ? parts.join(" · ") : "no selection";
};

const planGlyph = (
	status: PlanEntry["status"],
	spinnerFrame: string,
): { glyph: string; color: string } => {
	switch (status) {
		case "completed":
			return { glyph: "✓", color: DONE_COLOR };
		case "in_progress":
			return { glyph: spinnerFrame, color: CHIP_COLOR };
		case "pending":
			return { glyph: "○", color: MUTED_COLOR };
	}
};

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
	// The live turn, for the plan and the agent's last lines. Null before the first prompt.
	log: CopilotLog.Log | null;
	spinnerFrame: string;
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
	textareaRef,
	onSubmit,
	onContentChange,
}: CopilotPaneProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const running = copilot.turn === "running";
	const plan = log?.plan ?? [];
	const progress = plan.length > 0 ? planProgress(plan) : null;
	const fit = (text: string, room: number): string =>
		text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

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
	const planRows = plan.slice(0, MAX_PLAN_ROWS);
	const tail = (log?.tail ?? []).slice(-MAX_TAIL_ROWS);
	const rows = inputRows(copilot.text, height);
	// A shortcut palette replaces the plan while one is being picked: both at once is noise, and the
	// human typing `/` is not watching the todo.
	const showPalette = matches.length > 0;
	const showPlan = !showPalette && planRows.length > 0;
	const showTail = !showPalette && tail.length > 0;
	const state = running
		? "running"
		: copilot.turn === "error"
			? "stopped"
			: copilot.turn === "done"
				? "done"
				: "";
	const right = [
		progress,
		state,
		log ? elapsed(log.card.startedAt, log.card.finishedAt) : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<box
			style={{
				flexShrink: 0,
				flexDirection: "column",
				border: true,
				borderColor: CHIP_COLOR,
				backgroundColor: PANE_BG,
				paddingLeft: 1,
				paddingRight: 1,
			}}
			title={fit(`copilot · ${chip}${right ? ` · ${right}` : ""}`, width - 4)}
			titleColor={CHIP_COLOR}
		>
			{showPlan
				? planRows.map((entry) => {
						const { glyph, color } = planGlyph(entry.status, spinnerFrame);
						return (
							// The entry's text is its identity — only its status moves.
							<text key={entry.content} bg={PANE_BG} fg={color}>
								{glyph}{" "}
								<span
									fg={entry.status === "pending" ? MUTED_COLOR : TEXT_COLOR}
								>
									{fit(entry.content, width - 8)}
								</span>
							</text>
						);
					})
				: null}
			{showPlan && plan.length > MAX_PLAN_ROWS ? (
				<text bg={PANE_BG} fg={MUTED_COLOR}>
					…{plan.length - MAX_PLAN_ROWS} more
				</text>
			) : null}
			{showTail
				? tail.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a positional window on the last few lines, not a list of things — row N is its only identity, and the same line can legitimately repeat.
						<text key={index} bg={PANE_BG} fg={MUTED_COLOR}>
							{fit(line, width - 6)}
						</text>
					))
				: null}
			{showPalette
				? matches.map((shortcut, index) => (
						<text
							key={shortcut.name}
							bg={PANE_BG}
							fg={index === 0 ? TEXT_COLOR : MUTED_COLOR}
						>
							<span fg={index === 0 ? CHIP_COLOR : MUTED_COLOR}>
								{`/${shortcut.name}`.padEnd(14)}
							</span>
							{fit(shortcut.hint, width - 22)}
						</text>
					))
				: null}
			<box style={{ flexDirection: "row", height: rows }}>
				<text bg={PANE_BG} fg={CHIP_COLOR}>
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
					placeholder={PLACEHOLDER}
					placeholderColor={MUTED_COLOR}
					backgroundColor={PANE_BG}
					focusedBackgroundColor={PANE_BG}
					textColor={TEXT_COLOR}
					focusedTextColor={TEXT_COLOR}
					cursorColor={CHIP_COLOR}
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
	const text =
		log && status
			? planLine(log, status)
			: `▸ tab to ask the copilot${copilot.text ? ` · draft: ${copilot.text.split("\n")[0]}` : ""}`;
	const line =
		text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
	return (
		<box style={{ flexShrink: 0, height: 1, backgroundColor: PANE_BG }}>
			<text
				bg={PANE_BG}
				fg={status ? copilotIndicatorFg(status.tone) : MUTED_COLOR}
			>
				{line.padEnd(width)}
			</text>
		</box>
	);
};

// A running turn says which plan entry it is on — the agent's own words beat the tool name. A
// finished one keeps the footer's wording, which the tests already pin.
const planLine = (log: CopilotLog.Log, status: CopilotLog.Footer): string => {
	if (status.tone !== "running") return status.text;
	const current = log.plan.find((entry) => entry.status === "in_progress");
	return current
		? status.text.replace(log.activity, current.content)
		: status.text;
};
