/** @jsxImportSource @opentui/react */
// The tab bar across the top of every view, and the banner a session question leaves over the view
// it is shown on. The tracker is always tab 1, and the Jobs tab follows it while there is a job;
// every other tab is a host card that asked for one. A card tab's glyph is its card's state and its
// `?n` the questions its sessions are waiting on, so what is blocked shows from any tab; the
// tracker's `?n` counts every question, and the Jobs tab's the jobs whose run waits on the human. Only the tab on screen
// animates: a running card on another tab is the still echo (spinner.ts).
//
// A bar wider than the pane keeps the tracker, the tab on screen and every tab with a `?n` or an
// accent `?`, then as many of the rest as fit in tab order, and counts the others in a `+n` cell;
// `{` `}` still reach them.
import type { ActivityCard } from "@kabane/extension";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { createContext, type ReactNode, useContext } from "react";
import { Cockpit } from "./cockpit";
import { BoardJobs } from "./jobs";
import { RUNNING_ECHO, SPINNER_IDLE } from "./spinner";
import { STILL } from "./still";
import { BoardTabs } from "./tabs";
import { type Theme, useTheme } from "./theme";

type Part = { text: string; fg: string; bold?: boolean };

const glyphOf = (
	card: ActivityCard,
	onScreen: boolean,
	spinnerFrame: string,
	theme: Theme.Tokens,
	unseen: boolean,
): Part => {
	// A finished card that left issues for the human keeps the accent until its tab was on screen.
	if (unseen) return { text: "?", fg: theme.accent };
	switch (card.status) {
		case "running":
		case "pending":
			if (card.stale) return { text: SPINNER_IDLE, fg: theme.muted };
			return {
				text: onScreen ? spinnerFrame : RUNNING_ECHO,
				fg: theme.working,
			};
		case "paused":
		case "unreported":
			return { text: STILL[card.status].glyph, fg: theme.muted };
		case "completed":
			return { text: "✓", fg: theme.done };
		case "stopped":
			return { text: "⏹", fg: theme.muted };
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
	name: string,
	opts: {
		onScreen: boolean;
		waiting: number;
		spinnerFrame: string;
		theme: Theme.Tokens;
		unseen: boolean;
	},
): Part[] => {
	const { theme, onScreen } = opts;
	const fg = onScreen ? theme.text : theme.secondary;
	return [
		{ text: ` ${index} `, fg: theme.muted },
		...(card
			? [
					glyphOf(card, onScreen, opts.spinnerFrame, theme, opts.unseen),
					{ text: " ", fg },
				]
			: []),
		{ text: name, fg, bold: onScreen },
		...(opts.waiting > 0
			? [{ text: ` ?${opts.waiting}`, fg: theme.accent, bold: true }]
			: []),
		{ text: " ", fg },
	];
};

type Tab = {
	// The card's id, JOBS, or null for the tracker.
	id: string | null;
	card: ActivityCard | null;
	// Its place in the bar, which its number shows.
	index: number;
	onScreen: boolean;
	waiting: number;
	// A finished card whose left-for-you list the human has not seen: kept in sight like a `?n`.
	unseen: boolean;
	parts: Part[];
};

// A tab's columns: its parts, and the rule before every tab but the tracker.
const widthOf = (tab: Tab): number =>
	(tab.index > 0 ? 1 : 0) +
	tab.parts.reduce((sum, part) => sum + part.text.length, 0);

/** The tabs that fit in `room` columns, in tab order, and how many were left out. */
const fitting = (
	all: readonly Tab[],
	room: number,
): { shown: Tab[]; hidden: number } => {
	const total = all.reduce((sum, tab) => sum + widthOf(tab), 0);
	if (total <= room) return { shown: [...all], hidden: 0 };
	const kept = new Set(
		all.filter(
			(tab) => tab.index === 0 || tab.onScreen || tab.waiting > 0 || tab.unseen,
		),
	);
	// The `+n` cell, its rule included, at its widest.
	let left =
		room -
		` +${all.length} `.length -
		1 -
		[...kept].reduce((sum, tab) => sum + widthOf(tab), 0);
	for (const tab of all) {
		if (kept.has(tab) || widthOf(tab) > left) continue;
		kept.add(tab);
		left -= widthOf(tab);
	}
	const shown = all.filter((tab) => kept.has(tab));
	return { shown, hidden: all.length - shown.length };
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
	// A click on a tab: its card's id, BoardTabs.JOBS, or null for the tracker.
	onSelect?: (id: string | null) => void;
}): ReactNode => {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const all: Tab[] = BoardTabs.order(tabs)
		.flatMap((id) => {
			if (id === null || id === BoardTabs.JOBS)
				return [{ id, card: null as ActivityCard | null }];
			// A tab whose card the poll has not brought yet is skipped. Its state is the one the tab's
			// own poll saw last, which is ahead of the board's.
			const card = cards.find((one) => one.id === id);
			const status = tabs.cards.get(id)?.status;
			return card
				? [
						{
							id,
							card: status
								? { ...card, status, stale: tabs.cards.get(id)?.stale }
								: card,
						},
					]
				: [];
		})
		.map(({ id, card }, index) => {
			const onScreen = id === tabs.active;
			const waiting =
				id === BoardTabs.JOBS
					? BoardJobs.waitingCount(tabs.jobs)
					: BoardTabs.waitingOn(tabs, id);
			const name = card
				? (card.taskShortId ?? card.label)
				: id === null
					? "tracker"
					: "jobs";
			const unseen =
				id !== null && id !== BoardTabs.JOBS && BoardTabs.unseen(tabs, id);
			return {
				id,
				card,
				index,
				onScreen,
				waiting,
				unseen,
				parts: tabParts(index + 1, card, name, {
					onScreen,
					waiting,
					spinnerFrame,
					theme,
					unseen,
				}),
			};
		});
	const { shown, hidden } = fitting(all, width);
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				backgroundColor: theme.surface.raised,
			}}
		>
			{shown.map(({ id, index, onScreen, parts }) => {
				const bg = onScreen ? theme.surface.selected : theme.surface.raised;
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
						{parts.map((part, at) => (
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
			{hidden > 0 ? (
				<text
					bg={theme.surface.raised}
					wrapMode="none"
					style={{ flexShrink: 0 }}
				>
					<span fg={theme.faint}>│</span>
					<span fg={theme.muted}>{` +${hidden} `}</span>
				</text>
			) : null}
		</box>
	);
};

type QuestionBannerProps = {
	question: BoardTabs.Question;
	// The asking session's task, as the human reads it.
	taskShortId?: string;
	// Settled, and with what when this board answered it.
	answered: boolean;
	answer?: string;
	// On a multi-select, the choices toggled so far, by index.
	picked?: readonly number[];
	// Where `b` goes: the tabbed card the question is from, as its tab reads (`loop JREP-1`).
	back?: string;
	// On a card's tab, how many more of its questions wait behind this one.
	more?: number;
	// A click on an answer, by index.
	onAnswer: (index: number) => void;
	// The rows and columns it may take, where they run short (a card's tab).
	room?: BannerRoom;
};

/**
 * What a card tab's question may take: its rows (the blank row above it included), those of them
 * left once the map above it has all it wants, and its width. The cockpit provides it; without it
 * the banner takes the rows it needs.
 */
export type BannerRoom = { rows: number; spare: number; width: number };
export const BannerRoomContext = createContext<BannerRoom | null>(null);

// What `enter` does beside the choices: sends a multi-select's picks, types an answer the asker
// allows besides them.
const enterDoesOf = (question: BoardTabs.Question): string | null =>
	question.multiSelect
		? question.allowFreeform
			? "send the picks, or type an answer"
			: "send the picks"
		: question.allowFreeform
			? "type an answer"
			: null;

/**
 * The banner's words, and how it fits its room: how many blank rows it keeps and, when the question
 * is held to fewer rows than it needs, how many. Without a room, both blank rows and the whole
 * question.
 */
const bannerLayout = (
	{
		question,
		taskShortId,
		answered,
		answer,
		back,
		more = 0,
	}: Pick<
		QuestionBannerProps,
		"question" | "taskShortId" | "answered" | "answer" | "back" | "more"
	>,
	room: BannerRoom | undefined,
): {
	closed: boolean;
	status: string;
	asker: string;
	enterDoes: string | null;
	freeform: boolean;
	gaps: number;
	held: number | undefined;
} => {
	const freeform = question.choices.length === 0;
	// Settled without an answer from this board: answered elsewhere, or withdrawn by its asker. The
	// board cannot tell which, so it says only that the question is closed.
	const closed = answered && answer === undefined;
	const enterDoes = enterDoesOf(question);
	const asker = ` · ${question.lane ? `${question.lane} (${question.agent})` : question.agent} asks${taskShortId ? ` about ${taskShortId}` : ""}`;
	const status = closed ? "closed" : answered ? "✓ answered" : "waiting on you";
	const words = { closed, status, asker, enterDoes, freeform };
	if (!room) return { ...words, gaps: Cockpit.BANNER_GAPS, held: undefined };
	const said = `${answered ? "" : "? "}${question.question}${answer ? `  → ${answer}` : ""}`;
	const cells = [
		...question.choices.map(
			(choice, index) =>
				`${index > 0 ? " · " : ""}${index + 1} ${question.multiSelect ? "[x] " : ""}${choice}`,
		),
		...(enterDoes ? [` · enter ${enterDoes}`] : []),
	];
	const answers = answered
		? 0
		: freeform
			? 1
			: Cockpit.cellRows(cells, room.width);
	const parts = {
		header: Cockpit.wrapRows(
			`${status}${asker}${more > 0 ? ` · +${more} more` : ""}`,
			room.width,
		),
		question: Cockpit.wrapRows(said, room.width),
		answers: answers + (back ? 1 : 0),
	};
	const fit = Cockpit.bannerFit(parts, room.rows, room.spare);
	return {
		...words,
		gaps: fit.gaps,
		held: fit.question < parts.question ? fit.question : undefined,
	};
};

/**
 * A session question on a raised surface: who asks (the session, by its lane, and its harness)
 * about which task, the question, and its numbered
 * answers while it waits; what was answered once it is; and the way back to the card's tab. The
 * digits and a click answer it wherever it is pinned.
 */
const QuestionBanner = ({
	question,
	taskShortId,
	answered,
	answer,
	picked = [],
	back,
	more = 0,
	onAnswer,
	room,
}: QuestionBannerProps): ReactNode => {
	const theme = useTheme();
	const bg = theme.surface.raised;
	const { closed, status, asker, enterDoes, freeform, gaps, held } =
		bannerLayout({ question, taskShortId, answered, answer, back, more }, room);
	const questionText = (
		<text bg={bg} fg={theme.text}>
			{answered ? null : <span fg={theme.accent}>? </span>}
			{question.question}
			{answer ? <span fg={theme.done}>{`  → ${answer}`}</span> : null}
		</text>
	);
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				backgroundColor: bg,
				// A blank row above and below, as the copilot's ask panel has: a surface, not a strip.
				// Held to a room, the bottom one goes first, then the unpainted one above, then the top.
				...(room ? { marginTop: gaps >= 2 ? 1 : 0 } : {}),
				paddingTop: gaps >= 1 ? 1 : 0,
				paddingBottom: gaps >= 3 ? 1 : 0,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={bg} fg={theme.muted}>
				<span
					fg={closed ? theme.muted : answered ? theme.done : theme.accent}
					attributes={TextAttributes.BOLD}
				>
					{status}
				</span>
				{asker}
				{more > 0 ? <span fg={theme.accent}>{` · +${more} more`}</span> : null}
			</text>
			{held !== undefined ? (
				<scrollbox style={{ height: held, flexShrink: 0 }}>
					{questionText}
				</scrollbox>
			) : (
				questionText
			)}
			{answered ? null : freeform ? (
				// No answers to pick: `enter` opens the prompt to type one, here or over the task.
				<text bg={bg} fg={theme.muted}>
					<span fg={theme.text}>enter</span>
					{" type the answer"}
				</text>
			) : (
				// Each answer its own cell, so a click lands on the one it means: its key and its words in
				// the text color, the separator muted. A multi-select's cells say whether each is toggled.
				<box style={{ flexDirection: "row", flexShrink: 0, flexWrap: "wrap" }}>
					{question.choices.map((choice, index) => (
						<text
							key={choice}
							bg={bg}
							fg={theme.muted}
							onMouseDown={() => onAnswer(index)}
							style={{ flexShrink: 0 }}
						>
							{index > 0 ? " · " : ""}
							<span fg={theme.text}>{`${index + 1} `}</span>
							{question.multiSelect ? (
								<span fg={picked.includes(index) ? theme.accent : theme.muted}>
									{picked.includes(index) ? "[x] " : "[ ] "}
								</span>
							) : null}
							<span fg={theme.text}>{choice}</span>
						</text>
					))}
					{enterDoes ? (
						<text bg={bg} fg={theme.muted} style={{ flexShrink: 0 }}>
							{" · "}
							<span fg={theme.text}>enter</span>
							{` ${enterDoes}`}
						</text>
					) : null}
				</box>
			)}
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

/**
 * On a card's own tab, the question its sessions wait on, if any, answered in place, with how many
 * more wait behind it; nothing anywhere else.
 */
export const CardTabQuestion = ({
	tabs,
	onAnswer,
}: {
	tabs: BoardTabs.Tabs;
	onAnswer: (index: number) => void;
}): ReactNode => {
	const room = useContext(BannerRoomContext);
	const asked = BoardTabs.cardQuestion(tabs);
	if (!asked) return null;
	const answer = tabs.answered.get(asked.id);
	return (
		// Under a room the banner keeps the blank row above it itself, as one of the rows it may give up.
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginTop: room ? 0 : 1,
			}}
		>
			<QuestionBanner
				{...(room ? { room } : {})}
				question={asked}
				taskShortId={asked.taskShortId}
				answered={answer !== undefined}
				{...(answer !== undefined ? { answer } : {})}
				picked={BoardTabs.pickedOf(tabs, asked)}
				more={BoardTabs.moreOnCard(tabs)}
				onAnswer={onAnswer}
			/>
		</box>
	);
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
			picked={BoardTabs.pickedOf(tabs, banner.question)}
			back={from ? `${cardName(from)}'s tab` : undefined}
			onAnswer={onAnswer}
		/>
	);
};
