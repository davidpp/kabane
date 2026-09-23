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
import { type Theme, useTheme } from "./theme";

// The copilot indicator's colour by tone, shared by the board and detail footers: the accent while
// it runs and when it lands, the error red when it fails.
export const copilotIndicatorFg = (
	tone: CopilotLog.Footer["tone"],
	theme: Theme.Tokens,
): string => (tone === "error" ? theme.failed : theme.accent);

export type StatusBarProps = {
	text: string;
	fg?: string;
};

export const StatusBar = ({ text, fg }: StatusBarProps): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	// The bar sits on the raised surface: one step up from the terminal's own background, visible
	// as a bar, quiet as chrome. Text without a colour of its own takes the surface's foreground.
	const bg = theme.surface.raised;
	// Truncate-then-pad: one line, every column painted. Small screens cut hints, never wrap them.
	const line =
		text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
	return (
		<box
			style={{
				flexShrink: 0,
				height: 1,
				zIndex: 10,
				backgroundColor: bg,
			}}
		>
			<text bg={bg} fg={fg ?? theme.text}>
				{line.padEnd(width)}
			</text>
		</box>
	);
};
