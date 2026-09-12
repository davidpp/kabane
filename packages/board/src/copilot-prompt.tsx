/** @jsxImportSource @opentui/react */
// The `A` prompt window: one input row pinned just above the footer, with a chip on the left saying
// what the prompt carries (`JCAB-31 · 3 marked · inbox`) and, while the text starts with `/`, a row
// of the matching shortcuts above it. Pure display — the reducer (nav.ts reduceCopilotWindowKey)
// owns every key; the text is drawn with a cursor glyph the way the `/` search box is, so the one
// useKeyboard handler in app.tsx stays the only input path.
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { BoardContext } from "./context";
import { BoardNav } from "./nav";

const CHIP_COLOR = "#f97316";
const MUTED_COLOR = "#6b7280";
const TEXT_COLOR = "#e6edf3";
const WINDOW_BG = "#262626";

export const BUSY_NOTICE = "a turn is running · esc stops it";

// The chip text: the selected task, the working-set size, the section — whichever apply, in that
// order. Exported pure so the copy is assertable without a renderer.
export const contextChip = (ctx: BoardContext.Context): string => {
	const parts: string[] = [];
	if (ctx.selected) parts.push(ctx.selected.shortId);
	if (ctx.marked.length > 0) parts.push(`${ctx.marked.length} marked`);
	if (ctx.section) parts.push(ctx.section);
	return parts.length > 0 ? parts.join(" · ") : "no selection";
};

export type CopilotPromptProps = {
	copilot: BoardNav.CopilotState;
	chip: string;
};

export const CopilotPrompt = ({
	copilot,
	chip,
}: CopilotPromptProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const matches = BoardNav.matchingShortcuts(copilot.shortcuts, copilot.text);
	const rows = matches.length > 0 ? 2 : 1;
	const notice = copilot.turn === "running" ? ` · ${BUSY_NOTICE}` : "";
	// Everything left of the buffer, so the row pads to exactly one line.
	const lead = `${chip}${notice} ▸ `;
	const fit = (text: string): string =>
		text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
	const suggestions = matches.map((s) => `/${s.name} ${s.hint}`).join("  ");
	return (
		<box
			style={{
				position: "absolute",
				left: 0,
				// Directly above the footer's one reserved row, whichever view is under it.
				top: Math.max(0, height - 1 - rows),
				width,
				height: rows,
				zIndex: 50,
				flexDirection: "column",
				backgroundColor: WINDOW_BG,
			}}
		>
			{matches.length > 0 ? (
				<text bg={WINDOW_BG} fg={MUTED_COLOR}>
					{fit(suggestions).padEnd(width)}
				</text>
			) : null}
			<text bg={WINDOW_BG} fg={TEXT_COLOR}>
				<span fg={CHIP_COLOR}>{chip}</span>
				<span fg={MUTED_COLOR}>{`${notice} ▸ `}</span>
				{fit(`${copilot.text}▌`).padEnd(Math.max(0, width - lead.length))}
			</text>
		</box>
	);
};
