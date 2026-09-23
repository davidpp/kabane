/** @jsxImportSource @opentui/react */
// Detail view for a single task, read as parts rather than one wall. Pinned on a raised block: the
// title, the task at a glance, what is running on it and where it sits; under it, any question
// waiting on the human. Then tabs: the description, the comments and the agent log, one at a time,
// scrolled by app.tsx's `scroll` effect (it owns the ref so every key stays in the one useKeyboard
// handler). DetailModel decides what goes where; this file only draws it. The agent brief is not
// drawn here: `y` copies it, and it is what an agent reads.
import type { Result, TaskComment } from "@cabane/core";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import type { BoardActivity } from "./activity";
import type { BoardData } from "./data";
import { DetailModel } from "./detail-model";
import { ErrorBoundary } from "./error-boundary";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import type { ActivityCard, ActivityStatus } from "./ports";
import { Segments } from "./segments";
import { RUNNING_ECHO, SPINNER_IDLE } from "./spinner";
import { Theme, useTheme } from "./theme";

// Columns the header block's padding takes, and those the scrollbox's bar and a safety margin hold
// back, so a cut row is cut to the room it really has and never wraps.
const HEADER_PADDING = 2;
const SCROLL_RESERVED = 2;

// The one-line status under the header for the task's first in-flight card:
// `⠋ loop · implement · iteration 3 · $0.42` — the card's label then every detail line. When
// `spinnerFrame` is provided (threaded from app.tsx), it animates; falls back to SPINNER_IDLE for
// tests and static contexts. Exported pure so the text contract is assertable without a renderer.
export const cardStatusLine = (
	card: ActivityCard,
	spinnerFrame?: string,
): string => {
	if (card.status === "paused") return `⏸ ${card.label} · paused`;
	const glyph = card.stale ? SPINNER_IDLE : (spinnerFrame ?? RUNNING_ECHO);
	return [`${glyph} ${card.label}`, ...card.detail].join(" · ");
};

// Status glyph for a card row: animated spinner for running/pending, • for completed, ✗ for failed.
export const cardStatusGlyph = (
	status: ActivityStatus,
	spinnerFrame?: string,
): string => {
	switch (status) {
		case "running":
		case "pending":
			return spinnerFrame ?? RUNNING_ECHO;
		case "paused":
			return "⏸";
		case "completed":
			return "•";
		case "failed":
			return "✗";
	}
};

// Status color for a card glyph: DESIGN.md's glyph table. Running work is the working hue, never the
// accent — nothing about it is waiting on the human.
const cardGlyphColor = (
	status: ActivityStatus,
	theme: Theme.Tokens,
): string => {
	switch (status) {
		case "running":
		case "pending":
			return theme.working;
		case "completed":
			return theme.done;
		case "failed":
			return theme.failed;
		case "paused":
			return theme.muted;
	}
};

// Format elapsed time for a run: "12s", "2m14s", "1h3m".
export const formatElapsed = (ms: number | undefined): string => {
	if (ms == null || ms < 0) return "";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m${sec}s` : `${min}m`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
};

// One-line text for a card row in the log: `⠹ scout · running · 2m14s`.
export const cardRowLine = (
	card: ActivityCard,
	spinnerFrame?: string,
): string => {
	const glyph = cardStatusGlyph(card.status, spinnerFrame);
	const elapsed =
		card.durationMs != null ? ` · ${formatElapsed(card.durationMs)}` : "";
	return `${glyph} ${card.label} · ${card.status}${elapsed}`;
};

// Relative time label: "2d ago", "3h ago", "5m ago", "just now".
export const relativeTime = (iso: string, now: number = Date.now()): string => {
	const ms = now - Date.parse(iso);
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const days = Math.floor(hr / 24);
	return `${days}d ago`;
};

export type DetailProps = {
	taskId: string;
	// The selected task, fresh from the board's poll. Absent (e.g. filtered out on a poll) → the one
	// the records carry, else the id.
	task?: BoardData.DetailRecords["task"];
	// What the tabs show (BoardData.taskDetail): absent while it loads, an error when a read failed.
	records?: Result<BoardData.DetailRecords>;
	// Host activity cards for this task (BoardActivity, refreshed by app.tsx's poll): the first
	// in-flight one is the status line under the header; all of them head the log.
	cards?: ActivityCard[];
	// Questions the host says are parked on this task, beside any the records carry. Pinned, so what
	// is blocked on the human is the first thing they see.
	questions?: BoardActivity.AwaitingQuestion[];
	// The tab in view (BoardNav.detailTab) and what a click on another one asks for.
	tab?: DetailModel.Tab;
	onTab?: (tab: DetailModel.Tab) => void;
	// Animated spinner frame threaded from app.tsx — animates card glyphs.
	spinnerFrame?: string;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	// Transient footer feedback; replaces the hints in the footer for ~1.5s.
	notice?: BoardNav.Notice | null;
	// Which pane has the keyboard — the footer hints follow it.
	focus?: BoardNav.Focus;
	// The copilot pane, rendered between the content and the footer. A slot rather than a float: the
	// panel has real height and must push the view up, not cover it.
	pane?: ReactNode;
	// This task points at an issue in an external tracker, so `O` has somewhere to go. It gates the
	// footer hint; which issue is in the pinned meta lines.
	linked?: boolean;
	// Clicking the header [copy] affordance yanks the brief — same action as the `y` key.
	onCopy?: () => void;
	// Columns the sidebar takes beside the view, so the tab bar fits the room it really has.
	sidebarWidth?: number;
	// Whose keys the footer shows and what is true right now (BoardNav.keyContext / keySituation).
	// Optional so render-only tests fall back to what the view knows itself.
	keys?: Keymap.Live;
};

// Markdown render is the one place a throw can reach the app; wrap it so a parse failure degrades to
// the raw text instead of tearing down the tree.
const MarkdownBody = ({ content }: { content: string }): ReactNode => {
	const theme = useTheme();
	return (
		<ErrorBoundary fallback={<text fg={theme.defaultFg}>{content}</text>}>
			<markdown
				content={content}
				syntaxStyle={Theme.markdownStyle(theme)}
				fg={theme.defaultFg}
			/>
		</ErrorBoundary>
	);
};

export const Detail = ({
	taskId,
	task: freshTask,
	records,
	cards,
	questions,
	tab = DetailModel.DEFAULT_TAB,
	onTab,
	spinnerFrame,
	scrollRef,
	notice,
	focus = "board",
	pane,
	linked = false,
	onCopy,
	sidebarWidth = 0,
	keys,
}: DetailProps): ReactNode => {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const room = Math.max(0, width - sidebarWidth);
	const headerRoom = Math.max(0, room - HEADER_PADDING);
	const contentRoom = Math.max(0, room - SCROLL_RESERVED);
	const loaded = records?.ok ? records.value : undefined;
	const task = freshTask ?? loaded?.task;

	const shortId = task?.shortId ?? taskId.slice(0, 8);
	const header = [shortId, task?.title].filter(Boolean).join(" · ");
	const headline = cards?.find(
		(c) =>
			c.status === "running" || c.status === "pending" || c.status === "paused",
	);
	const open = DetailModel.openQuestions(loaded, questions);
	const summaries = DetailModel.tabs(loaded, cards?.length ?? 0);
	const live: Keymap.Live = keys ?? {
		context: focus === "copilot" ? "copilot" : "detail",
		situation: {
			linked,
			events: cards?.some((c) => c.hasEvents) ?? false,
		},
	};
	const hints = Keymap.footer(live.context, live.situation);

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			{/* The header block: the task, what is running on it and where it sits, one tonal step
			    up, the way opencode sets a message apart — a surface, never a rule. Painted, so every
			    cell names its fg. */}
			<box
				style={{
					flexDirection: "column",
					flexShrink: 0,
					backgroundColor: theme.surface.raised,
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				<box style={{ flexDirection: "row" }}>
					<text
						fg={theme.text}
						attributes={TextAttributes.BOLD}
						style={{ flexGrow: 1 }}
					>
						{header}
					</text>
					<text
						fg={notice?.tone === "success" ? theme.done : theme.muted}
						onMouseDown={onCopy}
						style={{ marginLeft: 1, flexShrink: 0 }}
					>
						[copy]
					</text>
				</box>
				{task ? (
					<SummaryLine parts={DetailModel.summary(task)} room={headerRoom} />
				) : null}
				{/* Boxed, not a bare <text>: a bare text sibling after the header row-box paints over row 0. */}
				{headline ? (
					<box style={{ flexDirection: "row", flexShrink: 0 }}>
						<text fg={headline.stale ? theme.muted : theme.working}>
							{cardStatusLine(headline, spinnerFrame)}
						</text>
					</box>
				) : null}
				{loaded
					? DetailModel.position(loaded).map((line) => (
							<MetaRow
								key={`${line.key} ${line.value}`}
								line={line}
								room={headerRoom}
							/>
						))
					: null}
			</box>
			{open.length > 0 ? (
				<box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
					{open.map((q) => (
						<text key={q.id} fg={theme.defaultFg}>
							<span fg={theme.accent}>?</span> {q.question}
						</text>
					))}
				</box>
			) : null}
			<TabBarRow summaries={summaries} active={tab} room={room} onTab={onTab} />
			{/* Keyed by tab, so a switch opens the new tab at its top rather than at the old scroll. */}
			<scrollbox
				key={tab}
				ref={scrollRef}
				style={{ flexGrow: 1, marginTop: 1 }}
			>
				{records === undefined ? (
					<text fg={theme.muted}>loading</text>
				) : !records.ok ? (
					<text fg={theme.failed}>{records.error.message}</text>
				) : (
					<TabContent
						tab={tab}
						records={records.value}
						cards={cards ?? []}
						spinnerFrame={spinnerFrame}
						room={contentRoom}
					/>
				)}
			</scrollbox>
			{pane}
			{notice ? (
				<StatusBar
					text={notice.undoable ? `${notice.text} · ⌃z undo` : notice.text}
					fg={notice.tone === "success" ? theme.done : theme.failed}
				/>
			) : (
				<StatusBar hints={hints} />
			)}
		</box>
	);
};

// The task at a glance under its title: meta in muted, a part waiting on the human in the accent.
// One row, its tail cut with `…` when the pane is narrow.
const SummaryLine = ({
	parts,
	room,
}: {
	parts: readonly DetailModel.SummaryPart[];
	room: number;
}): ReactNode => {
	const theme = useTheme();
	const segments = parts.map((part, index) => ({
		text: index === 0 ? part.text : ` · ${part.text}`,
		fg: part.request ? theme.accent : theme.muted,
	}));
	return <text>{Segments.spans(Segments.fit(segments, room))}</text>;
};

// A pinned fact: its key muted, its value in the text color, one row, its tail cut with `…`.
const MetaRow = ({
	line,
	room,
}: {
	line: DetailModel.MetaLine;
	room: number;
}): ReactNode => {
	const theme = useTheme();
	const segments = [
		{ text: `${line.key} `, fg: theme.muted },
		{ text: line.value, fg: theme.text },
	];
	return <text>{Segments.spans(Segments.fit(segments, room))}</text>;
};

// The tab bar: the active tab in Label weight on the selected surface, an empty one faint, every
// other in the terminal's own foreground; counts muted. A click on a cell asks for its tab.
const TabBarRow = ({
	summaries,
	active,
	room,
	onTab,
}: {
	summaries: readonly DetailModel.TabSummary[];
	active: DetailModel.Tab;
	room: number;
	onTab?: (tab: DetailModel.Tab) => void;
}): ReactNode => {
	const theme = useTheme();
	const bar = DetailModel.tabBar(summaries, room);
	const pad = " ".repeat(bar.pad);
	return (
		<box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1 }}>
			{bar.cells.map((cell, index) => {
				const summary = summaries.find((s) => s.tab === cell.tab);
				const isActive = cell.tab === active;
				const fg = isActive
					? theme.text
					: summary?.empty
						? theme.faint
						: theme.defaultFg;
				const [label = "", count] = cell.text.split(" ");
				return (
					<text
						key={cell.tab}
						bg={isActive ? theme.surface.selected : undefined}
						fg={fg}
						attributes={isActive ? TextAttributes.BOLD : undefined}
						onMouseDown={onTab ? () => onTab(cell.tab) : undefined}
						style={{
							flexShrink: 0,
							marginLeft: bar.pad === 0 && index > 0 ? 1 : 0,
						}}
					>
						{pad}
						{label}
						{count !== undefined ? (
							<span fg={isActive || summary?.empty ? fg : theme.muted}>
								{` ${count}`}
							</span>
						) : null}
						{pad}
					</text>
				);
			})}
		</box>
	);
};

const TabContent = ({
	tab,
	records,
	cards,
	spinnerFrame,
	room,
}: {
	tab: DetailModel.Tab;
	records: BoardData.DetailRecords;
	cards: readonly ActivityCard[];
	spinnerFrame?: string;
	// Columns a log row may use.
	room: number;
}): ReactNode => {
	const theme = useTheme();
	switch (tab) {
		case "description": {
			const description = records.task.description?.trim();
			return description ? (
				<MarkdownBody content={description} />
			) : (
				<text fg={theme.faint}>no description</text>
			);
		}
		case "comments": {
			const comments = DetailModel.comments(records);
			return comments.length > 0 ? (
				<box style={{ flexDirection: "column" }}>
					{comments.map((c, index) => (
						<CommentBlock key={c.id} comment={c} first={index === 0} />
					))}
				</box>
			) : (
				<text fg={theme.faint}>no comments</text>
			);
		}
		case "log": {
			const lines = DetailModel.log(records);
			return cards.length + lines.length > 0 ? (
				<box style={{ flexDirection: "column" }}>
					{cards.map((card) => (
						<CardRow
							key={card.id}
							card={card}
							spinnerFrame={spinnerFrame}
							room={room}
						/>
					))}
					{lines.map((line) => (
						<LogRow key={line.id} line={line} room={room} />
					))}
				</box>
			) : (
				<text fg={theme.faint}>nothing logged</text>
			);
		}
	}
};

// A card at the head of the log: the status glyph carries the hue, the label reads in the terminal's
// own foreground, and the status and elapsed time are meta.
const CardRow = ({
	card,
	spinnerFrame,
	room,
}: {
	card: ActivityCard;
	spinnerFrame?: string;
	room: number;
}): ReactNode => {
	const theme = useTheme();
	const glyph = cardStatusGlyph(card.status, spinnerFrame);
	const rest = cardRowLine(card, spinnerFrame).slice(glyph.length);
	const [label = "", ...meta] = rest.split(" · ");
	const segments = [
		{ text: glyph, fg: cardGlyphColor(card.status, theme) },
		{ text: label, fg: theme.defaultFg },
		{ text: meta.map((part) => ` · ${part}`).join(""), fg: theme.muted },
	];
	return <text>{Segments.spans(Segments.fit(segments, room))}</text>;
};

// One log line: glyph, kind and what was said, muted, its tail cut with `…`; its age held to the
// right so the cut never takes it. An error is the failed hue from end to end.
const LogRow = ({
	line,
	room,
}: {
	line: DetailModel.LogLine;
	room: number;
}): ReactNode => {
	const theme = useTheme();
	const fg = line.failed ? theme.failed : theme.muted;
	const kind = line.kind ? `${line.kind} ` : "";
	const age = relativeTime(line.at);
	const said = Segments.fit(
		[{ text: `${line.glyph} ${kind}${line.text}`, fg }],
		Math.max(0, room - age.length - 1),
	);
	return (
		<box style={{ flexDirection: "row" }}>
			<text style={{ flexGrow: 1, flexShrink: 1 }}>{Segments.spans(said)}</text>
			<text fg={theme.muted} style={{ flexShrink: 0, marginLeft: 1 }}>
				{age}
			</text>
		</box>
	);
};

// One comment as a raised block: who and when on the first line, what they said, whole, under it.
// A human and an agent are told apart by name and weight: a person's name is bold.
const CommentBlock = ({
	comment,
	first,
}: {
	comment: TaskComment;
	first: boolean;
}): ReactNode => {
	const theme = useTheme();
	const human = comment.authorType === "human";
	return (
		<box
			style={{
				flexDirection: "column",
				marginTop: first ? 0 : 1,
				backgroundColor: theme.surface.raised,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text fg={theme.text}>
				<span attributes={human ? TextAttributes.BOLD : undefined}>
					{DetailModel.actorName(comment.author)}
				</span>
				<span fg={theme.muted}> · {relativeTime(comment.createdAt)}</span>
			</text>
			<MarkdownBody content={comment.content.trim()} />
		</box>
	);
};
