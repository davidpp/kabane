/** @jsxImportSource @opentui/react */
// The agent's own todo list for the turn, one row per entry: the glyph IS the status — `✓` done, the
// spinner on the entry it is working, `○` still to come. Two surfaces show it, the copilot panel and
// the transcript it heads, and they must read as the same block rather than as two renderings that
// drifted apart. The caller owns its own chrome: how many rows it can afford, how wide an entry may
// be, and the background its rows sit on.
import type { ReactNode } from "react";
import type { PlanEntry } from "./ports";
import { type Theme, useTheme } from "./theme";

export const planGlyph = (
	status: PlanEntry["status"],
	spinnerFrame: string,
	theme: Theme.Tokens,
): { glyph: string; color: string } => {
	switch (status) {
		case "completed":
			return { glyph: "✓", color: theme.done };
		case "in_progress":
			return { glyph: spinnerFrame, color: theme.accent };
		case "pending":
			return { glyph: "○", color: theme.muted };
	}
};

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

export type PlanBlockProps = {
	plan: readonly PlanEntry[];
	spinnerFrame: string;
	// Columns an entry's text may take, chrome already subtracted by the caller.
	width: number;
	maxRows: number;
	// The surface's background, so a row inside a panel paints its whole width like its neighbours.
	bg?: string;
};

export const PlanBlock = ({
	plan,
	spinnerFrame,
	width,
	maxRows,
	bg,
}: PlanBlockProps): ReactNode => {
	const theme = useTheme();
	// On a painted surface the text takes the surface's foreground; off one, the terminal's own.
	const textFg = bg ? theme.text : theme.defaultFg;
	return (
		<>
			{plan.slice(0, maxRows).map((entry) => {
				const { glyph, color } = planGlyph(entry.status, spinnerFrame, theme);
				return (
					// The entry's text is its identity — only its status moves.
					<text key={entry.content} bg={bg} fg={color}>
						{glyph}{" "}
						<span fg={entry.status === "pending" ? theme.muted : textFg}>
							{fit(entry.content, width)}
						</span>
					</text>
				);
			})}
			{plan.length > maxRows ? (
				<text bg={bg} fg={theme.muted}>
					…{plan.length - maxRows} more
				</text>
			) : null}
		</>
	);
};
