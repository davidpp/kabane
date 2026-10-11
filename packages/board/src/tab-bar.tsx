/** @jsxImportSource @opentui/react */
// The tab bar across the top of every view, and the banner a session question leaves over the view
// it is shown on. The tracker is always tab 1; every other tab is a host card that asked for one. A
// tab's glyph is its card's state and its `?n` the questions its sessions are waiting on, so what is
// blocked shows from any tab; the tracker's `?n` counts every question. Only the tab on screen
// animates: a running card on another tab is the still echo (spinner.ts).
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { ActivityCard } from "./ports";
import { RUNNING_ECHO, SPINNER_IDLE } from "./spinner";
import { BoardTabs } from "./tabs";
import { type Theme, useTheme } from "./theme";

type Part = { text: string; fg: string; bold?: boolean };

const glyphOf = (
	card: ActivityCard,
	onScreen: boolean,
	spinnerFrame: string,
	theme: Theme.Tokens,
): Part => {
	switch (card.status) {
		case "running":
		case "pending":
			if (card.stale) return { text: SPINNER_IDLE, fg: theme.muted };
			return {
				text: onScreen ? spinnerFrame : RUNNING_ECHO,
				fg: theme.working,
			};
		case "paused":
			return { text: "⏸", fg: theme.muted };
		case "completed":
			return { text: "✓", fg: theme.done };
		case "failed":
			return { text: "✗", fg: theme.failed };
	}
};

/**
 * One tab's parts: its number (the order `{` `}` walk), its card's glyph, its name, and what waits
 * on the human there.
 */
const tabParts = (
	index: number,
	card: ActivityCard | null,
	opts: {
		onScreen: boolean;
		waiting: number;
		spinnerFrame: string;
		theme: Theme.Tokens;
	},
): Part[] => {
	const { theme, onScreen } = opts;
	const fg = onScreen ? theme.text : theme.secondary;
	return [
		{ text: ` ${index} `, fg: theme.muted },
		...(card
			? [glyphOf(card, onScreen, opts.spinnerFrame, theme), { text: " ", fg }]
			: []),
		{
			text: card ? (card.taskShortId ?? card.label) : "tracker",
			fg,
			bold: onScreen,
		},
		...(opts.waiting > 0
			? [{ text: ` ?${opts.waiting}`, fg: theme.accent, bold: true }]
			: []),
		{ text: " ", fg },
	];
};

export const TabBar = ({
	tabs,
	cards,
	spinnerFrame,
	onSelect,
}: {
	tabs: BoardTabs.Tabs;
	// Every card the board holds; the bar picks the open tabs' out of them, in tab order.
	cards: readonly ActivityCard[];
	spinnerFrame: string;
	// A click on a tab: its card's id, or null for the tracker.
	onSelect?: (id: string | null) => void;
}): ReactNode => {
	const theme = useTheme();
	const all: (ActivityCard | null)[] = [
		null,
		// A tab whose card the poll has not brought yet is skipped.
		...tabs.open.flatMap((id) => cards.find((card) => card.id === id) ?? []),
	];
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				backgroundColor: theme.surface.raised,
			}}
		>
			{all.map((card, index) => {
				const id = card?.id ?? null;
				const onScreen = id === tabs.active;
				const bg = onScreen ? theme.surface.selected : theme.surface.raised;
				const waiting = BoardTabs.waitingOn(tabs, id);
				return (
					// One cell per tab, so a click lands on the tab it means.
					<text
						key={id ?? "tracker"}
						bg={theme.surface.raised}
						wrapMode="none"
						onMouseDown={onSelect ? () => onSelect(id) : undefined}
						style={{ flexShrink: 0 }}
					>
						{index > 0 ? <span fg={theme.faint}>│</span> : null}
						{tabParts(index + 1, card, {
							onScreen,
							waiting,
							spinnerFrame,
							theme,
						}).map((part, at) => (
							<span
								// Index keys: a tab's parts are positional.
								key={at}
								bg={bg}
								fg={part.fg}
								attributes={part.bold ? TextAttributes.BOLD : 0}
							>
								{part.text}
							</span>
						))}
					</text>
				);
			})}
		</box>
	);
};

type QuestionBannerProps = {
	question: BoardTabs.Question;
	// The asking session's task, as the human reads it.
	taskShortId: string;
	// Settled, and with what when this board answered it.
	answered: boolean;
	answer?: string;
	// Where `b` goes: the tabbed card the question is from, as its tab reads (`loop JREP-1`).
	back?: string;
	// Over its own task the digits answer it; on a card's tab, `o` takes the human there to.
	answerable: boolean;
	// A click on an answer, by index.
	onAnswer?: (index: number) => void;
};

/**
 * A session question on a raised surface: who asks about which task, the question, and its numbered
 * answers while it waits; what was answered once it is; and the way back to the card's tab.
 */
const QuestionBanner = ({
	question,
	taskShortId,
	answered,
	answer,
	back,
	answerable,
	onAnswer,
}: QuestionBannerProps): ReactNode => {
	const theme = useTheme();
	const bg = theme.surface.raised;
	const freeform = question.choices.length === 0;
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				backgroundColor: bg,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={bg} fg={theme.muted}>
				<span
					fg={answered ? theme.done : theme.accent}
					attributes={TextAttributes.BOLD}
				>
					{answered ? "✓ answered" : "waiting on you"}
				</span>
				{` · ${question.agent} asks about ${taskShortId}`}
			</text>
			<text bg={bg} fg={theme.text}>
				{answered ? null : <span fg={theme.accent}>? </span>}
				{question.question}
				{answer ? <span fg={theme.done}>{`  → ${answer}`}</span> : null}
			</text>
			{answered ? null : freeform ? (
				<text bg={bg} fg={theme.muted}>
					no answers offered · answer it where it was asked
				</text>
			) : (
				// Each answer its own cell, so a click lands on the one it means.
				<box style={{ flexDirection: "row", flexShrink: 0 }}>
					{question.choices.map((choice, index) => (
						<text
							key={choice}
							bg={bg}
							fg={theme.muted}
							onMouseDown={
								answerable && onAnswer ? () => onAnswer(index) : undefined
							}
							style={{ flexShrink: 0 }}
						>
							{index > 0 ? " · " : ""}
							{answerable ? (
								<span fg={theme.text}>{`${index + 1} `}</span>
							) : null}
							{choice}
						</text>
					))}
				</box>
			)}
			{!answered && !answerable ? (
				<text bg={bg} fg={theme.muted}>
					<span fg={theme.text}>o</span>
					{` answer it over ${taskShortId}`}
				</text>
			) : null}
			{back ? (
				<text bg={bg} fg={theme.muted}>
					<span fg={theme.text}>b</span>
					{` back to ${back}`}
				</text>
			) : null}
		</box>
	);
};

// How a card's tab reads in a sentence: `loop JREP-1`.
const cardName = (card: ActivityCard): string =>
	[card.label, card.taskShortId].filter(Boolean).join(" ");

/** On a card's own tab, the question its sessions wait on, if any; nothing anywhere else. */
export const CardTabQuestion = ({
	tabs,
}: {
	tabs: BoardTabs.Tabs;
}): ReactNode => {
	const asked = BoardTabs.cardQuestion(tabs);
	return asked ? (
		<box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
			<QuestionBanner
				question={asked}
				taskShortId={asked.taskShortId}
				answered={false}
				answerable={false}
			/>
		</box>
	) : null;
};

/** The banner pinned over a detail view, if it has one, with the way back to its card's tab. */
export const PinnedQuestion = ({
	tabs,
	banner,
	cards,
	onAnswer,
}: {
	tabs: BoardTabs.Tabs;
	banner: BoardTabs.Banner | undefined;
	cards: readonly ActivityCard[];
	onAnswer: (index: number) => void;
}): ReactNode => {
	if (!banner) return null;
	const from = cards.find(
		(card) => card.id === banner.cardId && tabs.open.includes(card.id),
	);
	return (
		<QuestionBanner
			question={banner.question}
			taskShortId={banner.question.taskShortId}
			answered={BoardTabs.isAnswered(tabs, banner)}
			answer={banner.answer}
			back={from ? `${cardName(from)}'s tab` : undefined}
			answerable
			onAnswer={onAnswer}
		/>
	);
};
