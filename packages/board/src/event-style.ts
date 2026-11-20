import type { ActivityEvent, NoticeSeverity } from "@kabane/extension";
import type { ColorInput } from "@opentui/core";
import type { Theme } from "./theme";

// Per-event-type glyph and text colors. Types are host-defined strings; the common ones get a glyph,
// the rest a blank. The glyph carries the hue (DESIGN.md's glyph table): work that ran is the working
// hue, a question the accent, a failure the failed hue, the rest muted. The agent's own words carry
// no hue: they read on the terminal's foreground, dark or light; its thoughts are dimmed under them.
// Tool calls are not here: they are rows of their own (ToolCallRow).
export const eventStyle = (
	event: Pick<ActivityEvent, "type" | "severity" | "summary">,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	switch (event.type) {
		case "text":
			return { glyph: " ", glyphFg: theme.defaultFg, textFg: theme.defaultFg };
		case "thought":
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
		case "phase":
			return { glyph: "▶", glyphFg: theme.working, textFg: theme.defaultFg };
		case "done":
			return { glyph: "✓", glyphFg: theme.done, textFg: theme.secondary };
		case "progress":
			return { glyph: "·", glyphFg: theme.muted, textFg: theme.muted };
		case "permission":
			return { glyph: "?", glyphFg: theme.accent, textFg: theme.defaultFg };
		case "notice":
			return noticeStyle(
				event.severity ?? severityPrefix(event.summary),
				theme,
			);
		// The loop's own warnings (a claim it could not take, a question it gave up on).
		case "warning":
			return noticeStyle("warning", theme);
		case "error":
			return { glyph: "✗", glyphFg: theme.failed, textFg: theme.failed };
		case "metric":
			return { glyph: "$", glyphFg: theme.muted, textFg: theme.muted };
		default:
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
	}
};

// A notice that carries no severity of its own: the loop writes its harness's as `<severity>: <text>`,
// and its runs on disk keep them that way.
const severityPrefix = (summary: string): NoticeSeverity => {
	const prefix = /^(\w+):/.exec(summary)?.[1];
	return prefix === "warning" || prefix === "error" ? prefix : "info";
};

// What a harness wanted the human to know: a warning in the accent, since it says the session is not
// running the way it was asked to; an error in the failed hue; information muted.
const noticeStyle = (
	severity: NoticeSeverity,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	const fg =
		severity === "warning"
			? theme.accent
			: severity === "error"
				? theme.failed
				: theme.muted;
	return {
		glyph: "!",
		glyphFg: fg,
		textFg: fg === theme.muted ? theme.muted : theme.defaultFg,
	};
};
