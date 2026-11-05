/** @jsxImportSource @opentui/react */
// A decision an agent filed on the issue whose detail is open, pinned under its header: the
// copilot's form block (elicitation-block.tsx) on the question banner's raised surface, headed the
// way the banner heads a session's question. The keys are BoardDecisions'; this only draws the draft
// and hands a click to the same reducers.
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { BoardDecisions } from "./decisions";
import { DetailModel } from "./detail-model";
import { ElicitationBlock } from "./elicitation-block";
import type { BoardNav } from "./nav";
import { Segments } from "./segments";
import { useTheme } from "./theme";

// The panel's padding, a cell each side and a blank row above and below, and its heading row.
const PADDING_COLS = 2;
const CHROME_ROWS = 3;
// However short the terminal, the block has a few rows to ask in.
const MIN_BLOCK_ROWS = 6;

export type DecisionPanelProps = {
	asked: BoardDecisions.Shown;
	// Whether its keys are live (BoardDecisions.keysInHand), and who has them while they are not.
	inHand: boolean;
	reach?: BoardNav.AskReach;
	onSubmit: (text: string) => void;
	onPick?: (index: number) => void;
	onKey?: (name: string) => void;
	onReach?: () => void;
};

export const DecisionPanel = ({
	asked,
	inHand,
	reach,
	onSubmit,
	onPick,
	onKey,
	onReach,
}: DecisionPanelProps): ReactNode => {
	const theme = useTheme();
	const { width, height } = useTerminalDimensions();
	const bg = theme.surface.raised;
	const { decision } = asked;
	const inner = Math.max(0, width - PADDING_COLS);
	// One row, its tail cut: who asks matters less than that something waits.
	const heading = Segments.fit(
		[
			{
				text: "waiting on you",
				fg: theme.accent,
				attributes: TextAttributes.BOLD,
			},
			{
				text: ` · ${DetailModel.actorName(decision.askedBy)} asks · ${decision.handle}`,
				fg: theme.muted,
			},
		],
		inner,
	);
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginTop: 1,
				backgroundColor: bg,
				paddingTop: 1,
				paddingBottom: 1,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={bg}>{Segments.spans(heading)}</text>
			<ElicitationBlock
				request={decision.request}
				draft={asked.draft}
				waiting={asked.waiting}
				width={inner}
				// Up to half the terminal, as the copilot's ask panel, its chrome taken off.
				rows={Math.max(MIN_BLOCK_ROWS, Math.floor(height / 2) - CHROME_ROWS)}
				bg={bg}
				escape={BoardDecisions.escapes(asked)}
				inHand={inHand}
				reach={reach}
				onSubmit={onSubmit}
				onPick={onPick}
				onKey={onKey}
				onReach={onReach}
			/>
		</box>
	);
};

/**
 * The issue's decisions while a session's question is pinned over the view and has its keys: one
 * row saying they wait, until that question is settled and the view left.
 */
export const DecisionsWaiting = ({ count }: { count: number }): ReactNode => {
	const theme = useTheme();
	return (
		<text
			fg={theme.muted}
			style={{ flexShrink: 0, marginTop: 1, marginLeft: 1 }}
		>
			<span fg={theme.accent}>?</span>
			{` ${count} ${count === 1 ? "decision waits" : "decisions wait"} behind the question above`}
		</text>
	);
};
