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
import type { Keymap } from "./keymap";
import { type Theme, useTheme } from "./theme";

// The copilot indicator's colour by tone, shared by the board and detail footers: the working hue
// while a turn runs, done when it lands, failed when it fails. None of them is a request.
export const copilotIndicatorFg = (
	tone: CopilotLog.Footer["tone"],
	theme: Theme.Tokens,
): string => {
	switch (tone) {
		case "running":
			return theme.working;
		case "done":
			return theme.done;
		case "error":
			return theme.failed;
	}
};

/** A run of footer text in one colour. */
export type Segment = { text: string; fg: string };

/** Hints two-tone: the key in the bar's foreground, its label and the separators muted. */
export const hintSegments = (
	hints: readonly Keymap.Hint[],
	theme: Theme.Tokens,
): Segment[] =>
	hints.flatMap((hint, index) => [
		...(index > 0 ? [{ text: " · ", fg: theme.muted }] : []),
		{ text: hint.key, fg: theme.text },
		{ text: ` ${hint.label}`, fg: theme.muted },
	]);

/**
 * Segments cut to `width` columns, the last one ending in `…` when anything was cut. The same cut the
 * single-colour bar has always made, so a small screen truncates hints and never wraps them.
 */
export const fitSegments = (
	segments: readonly Segment[],
	width: number,
): Segment[] => {
	const total = segments.reduce((n, segment) => n + segment.text.length, 0);
	if (total <= width) return [...segments];
	const fitted: Segment[] = [];
	let room = Math.max(0, width - 1);
	for (const segment of segments) {
		if (room === 0) break;
		const text = segment.text.slice(0, room);
		fitted.push({ ...segment, text });
		room -= text.length;
	}
	const last = fitted.at(-1);
	if (last) fitted[fitted.length - 1] = { ...last, text: `${last.text}…` };
	return fitted;
};

export type StatusBarProps = {
	// One string in one colour: a notice, the live search query, a filter summary.
	text?: string;
	// Key hints, drawn two-tone. Wins over `text` when both are given.
	hints?: readonly Keymap.Hint[];
	fg?: string;
};

export const StatusBar = ({
	text = "",
	hints,
	fg,
}: StatusBarProps): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	// The bar sits on the raised surface: one step up from the terminal's own background, visible
	// as a bar, quiet as chrome. Text without a colour of its own takes the surface's foreground.
	const bg = theme.surface.raised;
	const segments = fitSegments(
		hints ? hintSegments(hints, theme) : [{ text, fg: fg ?? theme.text }],
		width,
	);
	const used = segments.reduce((n, segment) => n + segment.text.length, 0);
	return (
		<box
			style={{
				flexShrink: 0,
				height: 1,
				zIndex: 10,
				backgroundColor: bg,
			}}
		>
			<text bg={bg} fg={theme.text}>
				{segments.map((segment, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed run of segments, rebuilt each render.
					<span key={index} fg={segment.fg}>
						{segment.text}
					</span>
				))}
				{" ".repeat(Math.max(0, width - used))}
			</text>
		</box>
	);
};
