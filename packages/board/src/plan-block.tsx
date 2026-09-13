/** @jsxImportSource @opentui/react */
// The agent's own todo list for the turn, one row per entry: the glyph IS the status — `✓` done, the
// spinner on the entry it is working, `○` still to come. Two surfaces show it, the copilot panel and
// the transcript it heads, and they must read as the same block rather than as two renderings that
// drifted apart. The caller owns its own chrome: how many rows it can afford, how wide an entry may
// be, and the background its rows sit on.
import type { ReactNode } from "react";
import type { PlanEntry } from "./ports";

const CHIP_COLOR = "#f97316";
const MUTED_COLOR = "#6b7280";
const TEXT_COLOR = "#e6edf3";
const DONE_COLOR = "#22c55e";

export const planGlyph = (
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
}: PlanBlockProps): ReactNode => (
	<>
		{plan.slice(0, maxRows).map((entry) => {
			const { glyph, color } = planGlyph(entry.status, spinnerFrame);
			return (
				// The entry's text is its identity — only its status moves.
				<text key={entry.content} bg={bg} fg={color}>
					{glyph}{" "}
					<span fg={entry.status === "pending" ? MUTED_COLOR : TEXT_COLOR}>
						{fit(entry.content, width)}
					</span>
				</text>
			);
		})}
		{plan.length > maxRows ? (
			<text bg={bg} fg={MUTED_COLOR}>
				…{plan.length - maxRows} more
			</text>
		) : null}
	</>
);
