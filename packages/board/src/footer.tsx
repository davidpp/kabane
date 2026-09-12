/** @jsxImportSource @opentui/react */
// The one-line status bar both views mount at the bottom. A REAL footer, not a bare <text>: the box
// reserves its own row (flexShrink 0, fixed height) and the text pads to the full terminal width with
// an explicit background, so every cell in the row is owned and repainted each frame. That's the fix
// for the detail-view bug where hint text z-fought with overflowing brief content (two strings
// interleaved on one row) — a padded, backgrounded row can't be bled into. zIndex breaks paint-order
// ties in the footer's favor.
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { CopilotLog } from "./copilot-log";

// Slightly lifted from the terminal bg (selection is #2f2f2f) — visible as a bar, quiet as chrome.
export const FOOTER_BG = "#1c1c1c";

// The copilot indicator's colour by tone, shared by the board and detail footers: the accent while
// it runs and when it lands, the error red when it fails.
export const copilotIndicatorFg = (tone: CopilotLog.Footer["tone"]): string =>
	tone === "error" ? "#ef4444" : "#f97316";

export type StatusBarProps = {
	text: string;
	fg?: string;
};

export const StatusBar = ({ text, fg }: StatusBarProps): ReactNode => {
	const { width } = useTerminalDimensions();
	// Truncate-then-pad: one line, every column painted. Small screens cut hints, never wrap them.
	const line =
		text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
	return (
		<box
			style={{
				flexShrink: 0,
				height: 1,
				zIndex: 10,
				backgroundColor: FOOTER_BG,
			}}
		>
			<text bg={FOOTER_BG} fg={fg}>
				{line.padEnd(width)}
			</text>
		</box>
	);
};
