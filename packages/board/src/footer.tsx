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
import { Keymap } from "./keymap";
import { Segments } from "./segments";
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

/** Hints two-tone: the key in the bar's foreground, its label and the separators muted. */
export const hintSegments = (
	hints: readonly Keymap.Hint[],
	theme: Theme.Tokens,
): Segments.Segment[] =>
	hints.flatMap((hint, index) => [
		...(index > 0 ? [{ text: " · ", fg: theme.muted }] : []),
		{ text: hint.key, fg: theme.text },
		{ text: ` ${hint.label}`, fg: theme.muted },
	]);

// Between a lead (the query being typed, a search summary) and the hints after it.
const LEAD_GAP = "  ";

/**
 * The bar's parts for `width` columns. A lead keeps its words and gives way to nothing; hints after it
 * fit whole, dropping from the end with `? help` kept (Keymap.fitHints), so a hint is never cut
 * mid-word. A plain line with no hints is cut at the end with `…`, as a notice always was.
 */
export const barSegments = (
	{ text, fg, lead, leadFg, hints }: StatusBarProps,
	width: number,
	theme: Theme.Tokens,
): Segments.Segment[] => {
	if (!hints)
		return Segments.fit([{ text: text ?? "", fg: fg ?? theme.text }], width);
	const head: Segments.Segment[] = lead
		? [{ text: lead, fg: leadFg ?? theme.text }]
		: [];
	const room = Math.max(0, width - (lead ? lead.length + LEAD_GAP.length : 0));
	const fitted = Keymap.fitHints(hints, room);
	const gap: Segments.Segment[] =
		lead && fitted.length > 0 ? [{ text: LEAD_GAP, fg: theme.muted }] : [];
	return Segments.fit([...head, ...gap, ...hintSegments(fitted, theme)], width);
};

export type StatusBarProps = {
	// One string in one colour: a notice. Used when there are no hints.
	text?: string;
	fg?: string;
	// Key hints, drawn two-tone after the lead, if any.
	hints?: readonly Keymap.Hint[];
	// What the bar says before its hints: the live query, a search summary.
	lead?: string;
	leadFg?: string;
};

export const StatusBar = (props: StatusBarProps): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	// The bar sits on the raised surface: one step up from the terminal's own background, visible
	// as a bar, quiet as chrome. Text without a colour of its own takes the surface's foreground.
	const bg = theme.surface.raised;
	const segments = barSegments(props, width, theme);
	const used = Segments.plain(segments).length;
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
				{Segments.spans(segments)}
				{" ".repeat(Math.max(0, width - used))}
			</text>
		</box>
	);
};
