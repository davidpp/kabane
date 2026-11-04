/** @jsxImportSource @opentui/react */
// Event view: the event log behind one activity card, read through ActivitySource.events. Polls at
// 1s while the card is in flight, appending events incrementally. Auto-scrolls when pinned to the
// bottom; stops yanking if the user scrolled up.
//
// Two things are not rows: a plan, which heads the view pinned outside the scrollbox, and a `prompt`
// event, which is what was ASKED and so opens the turn that answers it as a block of its own, on the
// raised surface (opencode's user-message block, without its bar: DESIGN.md's No-Line Rule). And a
// tool call is one row however many events it took, closed until clicked (ToolRows folds them).

import {
	type ColorInput,
	RGBA,
	type Renderable,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { blockOnSurface, PROSE_MEASURE } from "./detail";
import { elapsed } from "./elapsed";
import { ErrorBoundary } from "./error-boundary";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import { PermissionBlock } from "./permission-block";
import { PlanBlock } from "./plan-block";
import {
	type ActivityCard,
	type ActivityDiff,
	type ActivityEvent,
	type ActivitySource,
	type CardHeader,
	type CopilotPermission,
	isInFlight,
	type PlanEntry,
	PROMPT_EVENT,
} from "./ports";
import { useSpinnerFrame } from "./spinner";
import { Theme, useMarkdownStyle, useTheme } from "./theme";
import { ToolRows } from "./tool-rows";

const POLL_MS = 1000;
// The transcript has the whole screen where the copilot panel has a dozen rows, so its pinned block
// can be taller — never tall enough to push the events it heads out of view.
const MAX_PLAN_ROWS = 8;
// The glyph and a cell to spare, reserved out of the row before an entry is fitted, and the floor
// below which fitting stops (a narrow frame gets a wrapped entry rather than an ellipsis alone).
const RESERVED_COLS = 3;
const MIN_ENTRY_COLS = 20;

const NO_PLAN: readonly PlanEntry[] = [];
const NO_PERMISSIONS: readonly CopilotPermission[] = [];

// The prompt block: its padding either side, the scrollbar and a cell to spare come out of the row,
// and it is held to a few rows so a long pasted prompt heads its turn rather than burying it.
const PROMPT_CHROME_COLS = 4;
const MAX_PROMPT_ROWS = 3;

// An opened call: its panel starts under the row's text, past the glyph, and is held to a few rows of
// input and a few more of output. Its chrome is that inset, the panel's padding and the scrollbar.
const BODY_INSET = 2;
const BODY_CHROME_COLS = BODY_INSET + 3;
const INPUT_ROWS = 6;
const OUTPUT_ROWS = 10;
// A diff gets more: it is what an edit was for. Its added and removed rows take this much of their
// hue over the panel. Split side by side only where each side still has room.
const DIFF_ROWS = 24;
const DIFF_TINT = 0.18;
const SPLIT_MIN_COLS = 120;
// A group's calls sit under its label once it is opened.
const GROUP_INDENT = 2;
const NOTHING_OPEN: ReadonlySet<string> = new Set();

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

const wrapWords = (text: string, room: number): string[] => {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const next = line === "" ? word : `${line} ${word}`;
		if (next.length <= room) {
			line = next;
			continue;
		}
		if (line !== "") lines.push(line);
		line = fit(word, room);
	}
	if (line !== "") lines.push(line);
	return lines;
};

/**
 * The prompt that opened a turn, word-wrapped to `room` and held to `max` rows, its own line breaks
 * kept and its blank lines dropped; the last row kept ends in `…` when there was more. Exported pure
 * so the wrapping is assertable without a renderer.
 */
export const promptLines = (
	prompt: string,
	room: number,
	max: number,
): string[] => {
	const lines = prompt
		.split("\n")
		.flatMap((paragraph) => wrapWords(paragraph, room));
	if (lines.length === 0) return [""];
	if (lines.length <= max) return lines;
	const kept = lines.slice(0, max);
	const last = kept[max - 1] ?? "";
	kept[max - 1] =
		last.length < room ? `${last}…` : `${last.slice(0, room - 1)}…`;
	return kept;
};

// Per-event-type glyph and text colors. Types are host-defined strings; the common ones get a glyph,
// the rest a blank. The glyph carries the hue (DESIGN.md's glyph table): work that ran is the working
// hue, a question the accent, a failure the failed hue, the rest muted. The agent's own words carry
// no hue: they read on the terminal's foreground, dark or light; its thoughts are dimmed under them.
// Tool calls are not here: they are rows of their own (ToolCallRow).
const eventStyle = (
	event: ActivityEvent,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	switch (event.type) {
		case "text":
			return { glyph: " ", glyphFg: theme.defaultFg, textFg: theme.defaultFg };
		case "thought":
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
		case "phase":
			return { glyph: "▶", glyphFg: theme.working, textFg: theme.defaultFg };
		case "progress":
			return { glyph: "·", glyphFg: theme.muted, textFg: theme.muted };
		case "permission":
			return { glyph: "?", glyphFg: theme.accent, textFg: theme.defaultFg };
		case "notice":
			return noticeStyle(event.summary, theme);
		case "error":
			return { glyph: "✗", glyphFg: theme.failed, textFg: theme.failed };
		case "metric":
			return { glyph: "$", glyphFg: theme.muted, textFg: theme.muted };
		default:
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
	}
};

// What a harness wanted the human to know, which the loop writes as `<severity>: <text>`: a warning
// in the accent, since it says the session is not running the way it was asked to; an error in the
// failed hue; anything else muted.
const noticeStyle = (
	summary: string,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	const severity = /^(\w+):/.exec(summary)?.[1];
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

// Status color for the header.
const statusColor = (status: string, theme: Theme.Tokens): string => {
	switch (status) {
		case "running":
		case "pending":
			return theme.working;
		case "completed":
			return theme.done;
		case "failed":
			return theme.failed;
		default:
			return theme.muted;
	}
};

export type EventViewProps = {
	cardId: string;
	// The card as last loaded by the board poll — the header renders from it until the source
	// refreshes it.
	initialCard: ActivityCard | undefined;
	source: ActivitySource;
	resolveShortId: (taskId: string) => string | undefined;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	notice?: BoardNav.Notice | null;
	// The card's todo list, pinned above the scrollbox so it stays readable while the events scroll.
	// A prop rather than a widening of ActivitySource: a plan is the copilot's shape, and the card
	// the board's own copilot writes is the only one that has one — the hosts behind the port have no
	// concept to implement. Empty (the default) is the flat one-line header every host card keeps.
	plan?: readonly PlanEntry[];
	// The question the copilot's harness is blocked on, drawn between the events and the footer —
	// outside the scrollbox, so reading back through the turn never scrolls the thing being asked
	// off screen, and where the eye already goes for what to press.
	// Oldest first: the head is the one asked, the rest are counted beneath it.
	permissions?: readonly CopilotPermission[];
	// Whose keys the footer shows and what is true right now (BoardNav.keyContext / keySituation):
	// `x` is hinted only on the copilot's transcript while its turn runs. Optional so render-only
	// tests get the transcript's own keys.
	keys?: Keymap.Live;
	// Pinned under the header, above the events: what the card's own tab says is waiting on the human.
	banner?: ReactNode;
	// The copilot pane, rendered between the content and the footer. A slot rather than a float: the
	// panel has real height and must push the view up, not cover it.
	pane?: ReactNode;
	// Shown as the card's own tab: a live stream, pinned to its newest line until the human scrolls
	// up, with its lanes as chips.
	tabbed?: boolean;
	// The lane on screen (null is every lane), and a click on a chip by index (0 is every lane).
	lane?: string | null;
	onLane?: (index: number) => void;
	// Each refreshed card, so the keys see what its chips show (BoardTabs.withCard).
	onCard?: (card: ActivityCard) => void;
	// The host's own header for this card's kind, in place of the one-line title; `expanded` is the
	// tab's `e`.
	header?: CardHeader;
	expanded?: boolean;
};

const TRANSCRIPT_KEYS: Keymap.Live = { context: "transcript", situation: {} };

/** The events a lane shows: its own, plus the ones the host left on no lane. Null shows them all. */
const laneEvents = (
	events: readonly ActivityEvent[],
	lane: string | null,
): readonly ActivityEvent[] =>
	lane === null
		? events
		: events.filter((e) => e.lane === undefined || e.lane === lane);

// The tag column on the all-lanes stream: as wide as the widest lane, but never more than a quarter
// of the row, so a forty-column pane keeps room for what was said.
const tagCols = (lanes: readonly string[], width: number): number =>
	Math.min(
		Math.max(0, ...lanes.map((lane) => lane.length)),
		Math.max(6, Math.floor(width / 4)),
	);

type Tag = { text: string; fg: string };

/**
 * Polls the card and its events: every second while it is in flight, once when it is over. A card
 * the board's own poll sees in flight again (a host restarted its work) is polled again.
 */
const useCardEvents = (
	cardId: string,
	source: ActivitySource,
	initialCard: ActivityCard | undefined,
	onCard: ((card: ActivityCard) => void) | undefined,
): { card: ActivityCard | null; events: ActivityEvent[] } => {
	const [card, setCard] = useState<ActivityCard | null>(initialCard ?? null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const lastSeqRef = useRef(0);
	// A ref, so the poll stays keyed on the card and its source while the callback is a fresh closure
	// every render.
	const onCardRef = useRef(onCard);
	onCardRef.current = onCard;
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const relaunched = initialCard !== undefined && isInFlight(initialCard);
	useEffect(() => {
		let cancelled = false;
		const poll = async (): Promise<void> => {
			if (source.card) {
				const refreshed = await source.card(cardId);
				if (cancelled) return;
				if (refreshed.ok && refreshed.value) {
					setCard(refreshed.value);
					onCardRef.current?.(refreshed.value);
					if (!isInFlight(refreshed.value) && timerRef.current) {
						clearInterval(timerRef.current);
						timerRef.current = null;
					}
				}
			}
			if (!source.events) return;
			const page = await source.events(cardId, lastSeqRef.current);
			if (cancelled) return;
			if (page.ok && page.value.length > 0) {
				setEvents((prev) => [...prev, ...page.value]);
				const last = page.value[page.value.length - 1];
				if (last) lastSeqRef.current = last.seq;
			}
		};

		void poll();
		timerRef.current = setInterval(() => {
			void poll();
		}, POLL_MS);

		return () => {
			cancelled = true;
			if (timerRef.current) clearInterval(timerRef.current);
		};
		// `relaunched` only restarts the poll, which reads the card from the source itself.
	}, [cardId, source, relaunched]);
	return { card, events };
};

export const EventView = ({
	cardId,
	initialCard,
	source,
	resolveShortId,
	scrollRef,
	notice,
	plan = NO_PLAN,
	permissions = NO_PERMISSIONS,
	keys = TRANSCRIPT_KEYS,
	banner,
	pane,
	tabbed = false,
	lane = null,
	onLane,
	onCard,
	header: Header,
	expanded = false,
}: EventViewProps): ReactNode => {
	const { card, events } = useCardEvents(cardId, source, initialCard, onCard);
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	const spinnerFrame = useSpinnerFrame(card ? isInFlight(card) : false);

	if (!card) {
		return (
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<text fg={theme.muted}>loading…</text>
			</box>
		);
	}

	const hints = Keymap.footer(keys.context, keys.situation, keys.host);
	const contentWidth = Math.max(MIN_ENTRY_COLS, width - RESERVED_COLS);
	const lanes = tabbed ? (card.lanes ?? []) : [];

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			{Header ? (
				// Less the cell the scrollbar column keeps clear.
				<Header card={card} width={width - 1} expanded={expanded} />
			) : (
				<TitleRow card={card} resolveShortId={resolveShortId} />
			)}
			{banner}
			{plan.length > 0 ? (
				<box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
					<PlanBlock
						plan={plan}
						spinnerFrame={spinnerFrame}
						width={contentWidth}
						maxRows={MAX_PLAN_ROWS}
					/>
				</box>
			) : null}
			{lanes.length > 0 ? (
				<LaneStrip
					lanes={lanes}
					lane={lane}
					allLabel={`all ${card.laneNoun ?? "lanes"} · live`}
					{...(onLane ? { onLane } : {})}
				/>
			) : null}
			<Stream
				card={card}
				events={laneEvents(events, lanes.length > 0 ? lane : null)}
				// Tags only where lines from several lanes interleave: the all-lanes stream.
				lanes={lane === null ? lanes : []}
				width={width}
				scrollRef={scrollRef}
				tabbed={tabbed}
				spinnerFrame={spinnerFrame}
			/>
			{permissions[0] ? (
				<box
					style={{
						flexDirection: "column",
						flexShrink: 0,
						marginTop: 1,
						backgroundColor: theme.surface.raised,
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					<PermissionBlock
						request={permissions[0]}
						waiting={permissions.length - 1}
						width={contentWidth}
						bg={theme.surface.raised}
					/>
				</box>
			) : null}
			{pane}
			{notice ? (
				<StatusBar
					text={notice.text}
					fg={notice.tone === "success" ? theme.done : theme.failed}
				/>
			) : (
				<StatusBar hints={hints} />
			)}
		</box>
	);
};

// The events, and how the card ended. A card's tab is a live stream: pinned to the newest line until
// the human scrolls up, and pinned again once back down. On the all-lanes stream each line carries
// its lane's tag in the lane's series color, the same one its chip has. Tool calls are one row each,
// closed until clicked, and a run of reads and searches one row for the lot (ToolRows).
const Stream = ({
	card,
	events,
	lanes,
	width,
	scrollRef,
	tabbed,
	spinnerFrame,
}: {
	card: ActivityCard;
	events: readonly ActivityEvent[];
	lanes: readonly string[];
	width: number;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	tabbed: boolean;
	spinnerFrame: string;
}): ReactNode => {
	const theme = useTheme();
	const live = isInFlight(card);
	const rows = useMemo(() => ToolRows.rows(events, live), [events, live]);
	const { open, toggle } = useOpenRows(rows, scrollRef);
	const cols = lanes.length > 0 ? tagCols(lanes, width) : 0;
	const tagRoom = cols > 0 ? cols + 1 : 0;
	const promptRoom = Math.max(
		MIN_ENTRY_COLS,
		width - PROMPT_CHROME_COLS - tagRoom,
	);
	// What an opened call's text may use: the row less its tag, its glyph, the panel's padding and the
	// scrollbar.
	const bodyRoom = Math.max(MIN_ENTRY_COLS, width - tagRoom - BODY_CHROME_COLS);
	const tagOf = (lane: string | undefined): Tag | undefined => {
		if (cols === 0 || lane === undefined) return undefined;
		return {
			text: fit(lane, cols).padEnd(cols),
			fg: Theme.seriesOf(theme, Math.max(0, lanes.indexOf(lane))),
		};
	};
	const callRow = (call: ToolRows.Call, indent: number): ReactNode => (
		<ToolCallRow
			key={call.key}
			call={call}
			tag={tagOf(call.lane)}
			indent={indent}
			open={open.has(call.key)}
			onToggle={(header) => toggle(call.key, header)}
			spinnerFrame={spinnerFrame}
			room={bodyRoom - indent}
			split={width > SPLIT_MIN_COLS}
		/>
	);
	return (
		<scrollbox
			ref={scrollRef}
			stickyScroll={tabbed}
			stickyStart="bottom"
			style={{ flexGrow: 1, marginTop: 1 }}
		>
			{rows.length === 0 ? (
				<text fg={theme.muted}>no events yet</text>
			) : (
				rows.map((row, index) => {
					switch (row.type) {
						case "call":
							return callRow(row.call, 0);
						case "group": {
							const { group } = row;
							const opened = open.has(group.key);
							return (
								<box
									key={group.key}
									style={{ flexDirection: "column", flexShrink: 0 }}
								>
									<ToolGroupRow
										group={group}
										tag={tagOf(group.lane)}
										open={opened}
										onToggle={(header) => toggle(group.key, header)}
										spinnerFrame={spinnerFrame}
									/>
									{opened
										? group.calls.map((call) => callRow(call, GROUP_INDENT))
										: null}
								</box>
							);
						}
						case "event":
							return row.event.type === PROMPT_EVENT ? (
								<PromptBlock
									key={row.event.seq}
									lines={promptLines(
										row.event.summary,
										promptRoom,
										MAX_PROMPT_ROWS,
									)}
									first={index === 0}
									tag={tagOf(row.event.lane)}
								/>
							) : (
								<EventRow
									key={row.event.seq}
									event={row.event}
									tag={tagOf(row.event.lane)}
								/>
							);
					}
				})
			)}
			<Ending card={card} />
		</scrollbox>
	);
};

// Which tool rows are open, by key. A click opens or closes the row under it. Its header keeps its
// place on screen through the layout that follows (ScrollBox.anchor, as opencode's session view
// does), unless it is the last row while the stream follows its newest line: anchored there, what it
// opens would go below the screen. A drag that selected text is not a click.
const useOpenRows = (
	rows: readonly ToolRows.Row[],
	scrollRef: RefObject<ScrollBoxRenderable | null>,
): {
	open: ReadonlySet<string>;
	toggle: (key: string, header: Renderable | null) => void;
} => {
	const renderer = useRenderer();
	const [open, setOpen] = useState<ReadonlySet<string>>(NOTHING_OPEN);
	const lastKey = rowKey(rows[rows.length - 1]);
	const toggle = (key: string, header: Renderable | null): void => {
		if (renderer.getSelection()?.getSelectedText()) return;
		const scroll = scrollRef.current;
		const following =
			scroll !== null &&
			scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height;
		if (scroll && header && !(key === lastKey && following))
			scroll.afterLayout(scroll.anchor(header));
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	};
	return { open, toggle };
};

const rowKey = (row: ToolRows.Row | undefined): string | undefined => {
	switch (row?.type) {
		case "call":
			return row.call.key;
		case "group":
			return row.group.key;
		default:
			return undefined;
	}
};

// The board's own one-line header for a card: its label, its task, its status and how long it ran.
const TitleRow = ({
	card,
	resolveShortId,
}: {
	card: ActivityCard;
	resolveShortId: (taskId: string) => string | undefined;
}): ReactNode => {
	const theme = useTheme();
	const shortId =
		card.taskShortId ??
		(card.taskId ? (resolveShortId(card.taskId) ?? "—") : "—");
	return (
		<text style={{ flexShrink: 0 }}>
			<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
				{card.label}
			</span>
			<span fg={theme.muted}>{` · ${shortId} · `}</span>
			<span fg={statusColor(card.status, theme)}>{card.status}</span>
			<span fg={theme.muted}>
				{` · ${elapsed(card.startedAt, card.finishedAt)}`}
			</span>
		</text>
	);
};

// The line under the last event once the card is over.
const Ending = ({ card }: { card: ActivityCard }): ReactNode => {
	const theme = useTheme();
	const line =
		card.status === "completed"
			? {
					text: `completed · ${elapsed(card.startedAt, card.finishedAt)}`,
					fg: theme.done,
				}
			: card.status === "failed" && card.error
				? { text: `failed: ${card.error}`, fg: theme.failed }
				: card.status === "stopped"
					? {
							text: card.error ? `stopped: ${card.error}` : "stopped",
							fg: theme.muted,
						}
					: null;
	return line ? (
		<box style={{ marginTop: 1 }}>
			<text fg={line.fg}>{line.text}</text>
		</box>
	) : null;
};

// The lanes as chips, the one on screen on the selected surface with a `▸`: which stream is being
// read has to show at a glance, and the first chip says the whole card's stream is live there. Each
// lane's chip carries its series color, the same one its lines are tagged with.
const LaneStrip = ({
	lanes,
	lane,
	allLabel,
	onLane,
}: {
	lanes: readonly string[];
	lane: string | null;
	allLabel: string;
	onLane?: (index: number) => void;
}): ReactNode => {
	const theme = useTheme();
	const on = lane === null ? 0 : lanes.indexOf(lane) + 1;
	return (
		<box style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0 }}>
			{[allLabel, ...lanes].map((name, index) => {
				const picked = index === on;
				const fg = index === 0 ? theme.text : Theme.seriesOf(theme, index - 1);
				return (
					// One cell per chip, so a click selects the lane it lands on.
					<text
						key={name}
						bg={picked ? theme.surface.selected : undefined}
						fg={picked || index > 0 ? fg : theme.muted}
						attributes={picked ? TextAttributes.BOLD : 0}
						onMouseDown={onLane ? () => onLane(index) : undefined}
						wrapMode="none"
						style={{ flexShrink: 0 }}
					>
						{picked ? ` ▸ ${name} ` : `   ${name} `}
					</text>
				);
			})}
		</box>
	);
};

// The prompt a turn opened with, on the raised surface across the row. A gap above parts it from the
// turn before; the first turn needs none, the header's own gap already stands there.
const PromptBlock = ({
	lines,
	first,
	tag,
}: {
	lines: readonly string[];
	first: boolean;
	tag?: Tag;
}): ReactNode => {
	const theme = useTheme();
	const bg = theme.surface.raised;
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginTop: first ? 0 : 1,
				backgroundColor: bg,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			{lines.map((line, index) => (
				// Index keys: wrapped rows of one prompt are positional, and a row can repeat.
				<text key={index} bg={bg} fg={theme.text}>
					{tag ? (
						<span fg={tag.fg}>
							{index === 0 ? `${tag.text} ` : " ".repeat(tag.text.length + 1)}
						</span>
					) : null}
					{line}
				</text>
			))}
		</box>
	);
};

// One event: the lane's tag and the glyph hold their columns, and the text wraps beside
// them with a hanging indent, so an agent's paragraph reads as a paragraph instead of restarting at
// column 0. A thought is dimmed under the agent's words.
const EventRow = ({
	event,
	tag,
}: {
	event: ActivityEvent;
	tag?: Tag;
}): ReactNode => {
	const theme = useTheme();
	const { glyph, glyphFg, textFg } = eventStyle(event, theme);
	return (
		<box style={{ flexDirection: "row", flexShrink: 0 }}>
			{tag ? (
				<text fg={tag.fg} style={{ flexShrink: 0 }}>
					{`${tag.text} `}
				</text>
			) : null}
			<text fg={glyphFg} style={{ flexShrink: 0 }}>
				{`${glyph} `}
			</text>
			{event.type === "text" ? (
				<AgentText text={event.summary} />
			) : (
				<text
					fg={textFg}
					attributes={event.type === "thought" ? TextAttributes.ITALIC : 0}
					style={{ flexGrow: 1, flexShrink: 1 }}
				>
					{event.summary}
				</text>
			)}
		</box>
	);
};

// What the agent said, rendered as the markdown it is written in, the way the brief is: code and
// quotes on a surface, prose on the terminal's foreground stopping at the measure. Not `streaming`:
// both hosts write a message once it is whole, so there is no trailing block still arriving. A parse
// that throws falls back to the text as it came.
const AgentText = ({ text }: { text: string }): ReactNode => {
	const theme = useTheme();
	const syntaxStyle = useMarkdownStyle();
	const renderNode = useMemo(() => blockOnSurface(theme), [theme]);
	const fallback = (
		<text fg={theme.defaultFg} style={{ flexGrow: 1, flexShrink: 1 }}>
			{text}
		</text>
	);
	return (
		<box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
			<ErrorBoundary fallback={fallback}>
				<markdown
					content={text.trim()}
					syntaxStyle={syntaxStyle}
					fg={theme.defaultFg}
					renderNode={renderNode}
					style={{ maxWidth: PROSE_MEASURE }}
				/>
			</ErrorBoundary>
		</box>
	);
};

// A call's glyph says how it went: the spinner while it runs, a muted check once it ended, the
// failed hue when it failed, the tool glyph when nothing said. Tool rows recede under the agent's
// words: a check is muted, and only a failure keeps its hue.
const callGlyph = (
	status: ToolRows.Call["status"],
	spinnerFrame: string,
	theme: Theme.Tokens,
): { glyph: string; fg: ColorInput } => {
	switch (status) {
		case "running":
			return { glyph: spinnerFrame, fg: theme.working };
		case "completed":
			return { glyph: "✓", fg: theme.muted };
		case "failed":
			return { glyph: "✗", fg: theme.failed };
		case "unknown":
			return { glyph: "⚙", fg: theme.muted };
	}
};

// The one line a call is while closed: its glyph, the tool, the first line of what it was called on
// as an aside cut to the row, and how long it took. opencode's InlineToolRow
// (routes/session/message-parts.tsx): a fixed glyph cell, the label, the status after it.
const ToolCallRow = ({
	call,
	tag,
	indent,
	open,
	onToggle,
	spinnerFrame,
	room,
	split,
}: {
	call: ToolRows.Call;
	tag?: Tag;
	indent: number;
	open: boolean;
	onToggle: (header: Renderable | null) => void;
	spinnerFrame: string;
	room: number;
	split: boolean;
}): ReactNode => {
	const theme = useTheme();
	const { glyph, fg } = callGlyph(call.status, spinnerFrame, theme);
	const { name, args } = ToolRows.toolParts(call.summary);
	const took = ToolRows.duration(call);
	const body = open ? <ToolBody call={call} room={room} split={split} /> : null;
	return (
		<box style={{ flexDirection: "column", flexShrink: 0 }}>
			<box
				style={{ flexDirection: "row", flexShrink: 0, paddingLeft: indent }}
				onMouseUp={(event) => onToggle(event.currentTarget)}
			>
				{tag ? (
					<text fg={tag.fg} style={{ flexShrink: 0 }}>
						{`${tag.text} `}
					</text>
				) : null}
				<text fg={fg} style={{ flexShrink: 0 }}>
					{`${glyph} `}
				</text>
				<text
					fg={call.status === "failed" ? theme.failed : theme.secondary}
					wrapMode="none"
					truncate
					style={{ flexShrink: 1, minWidth: 0 }}
				>
					{name}
					{args ? (
						<span fg={theme.muted} attributes={TextAttributes.ITALIC}>
							{` ${args}`}
						</span>
					) : null}
				</text>
				{took ? (
					<text fg={theme.muted} style={{ flexShrink: 0 }}>
						{` · ${took}`}
					</text>
				) : null}
			</box>
			{body}
		</box>
	);
};

// A run of reads and searches as one row: the spinner while one runs, then the caret that says it
// opens. opencode's exploring group (routes/session/group-view.tsx), its `✱`/`→` swapped for the
// board's own caret (DESIGN.md: `▸`/`▾` mark expandability).
const ToolGroupRow = ({
	group,
	tag,
	open,
	onToggle,
	spinnerFrame,
}: {
	group: ToolRows.Group;
	tag?: Tag;
	open: boolean;
	onToggle: (header: Renderable | null) => void;
	spinnerFrame: string;
}): ReactNode => {
	const theme = useTheme();
	const running = ToolRows.groupStatus(group) === "running";
	return (
		<box
			style={{ flexDirection: "row", flexShrink: 0 }}
			onMouseUp={(event) => onToggle(event.currentTarget)}
		>
			{tag ? (
				<text fg={tag.fg} style={{ flexShrink: 0 }}>
					{`${tag.text} `}
				</text>
			) : null}
			<text
				fg={running ? theme.working : theme.muted}
				style={{ flexShrink: 0 }}
			>
				{`${running ? spinnerFrame : open ? "▾" : "▸"} `}
			</text>
			<text
				fg={theme.secondary}
				wrapMode="none"
				truncate
				style={{ flexShrink: 1, minWidth: 0 }}
			>
				{ToolRows.groupLabel(group)}
			</text>
		</box>
	);
};

// An opened call, on the raised surface under its row: what it changed as a diff, else the head of
// its input (or the whole title, when the row cut it), then the tail of its output, each held to a
// few rows. A failed call's output is its error, in the failed hue.
const ToolBody = ({
	call,
	room,
	split,
}: {
	call: ToolRows.Call;
	room: number;
	split: boolean;
}): ReactNode => {
	const theme = useTheme();
	const bg = theme.surface.raised;
	const title = call.summary.trim();
	const diffs = call.detail.diffs ?? [];
	const input =
		diffs.length > 0
			? undefined
			: (call.detail.input ??
				(title.includes("\n") || title.length > room ? title : undefined));
	const output = call.detail.output;
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginLeft: BODY_INSET,
				backgroundColor: bg,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			{input ? (
				<text bg={bg} fg={theme.text} wrapMode="word">
					{ToolRows.head(input, INPUT_ROWS, INPUT_ROWS * room)}
				</text>
			) : null}
			{diffs.map((diff, index) => (
				// Index keys: a call's diffs are positional and never reorder.
				<FileDiff
					key={index}
					diff={diff}
					named={diffs.length > 1}
					split={split}
				/>
			))}
			{output ? (
				<text
					bg={bg}
					fg={call.status === "failed" ? theme.failed : theme.secondary}
					wrapMode="word"
				>
					{ToolRows.tail(output, OUTPUT_ROWS, OUTPUT_ROWS * room)}
				</text>
			) : null}
			{!input && diffs.length === 0 && !output ? (
				<text bg={bg} fg={theme.muted}>
					nothing more to show
				</text>
			) : null}
		</box>
	);
};

// A hue laid over the panel it sits on, for the rows a diff added or removed: the terminal cannot
// blend, so the mix is done here.
const tint = (hue: string, ground: string, amount: number): RGBA => {
	const over = RGBA.fromHex(hue);
	const under = RGBA.fromHex(ground);
	return RGBA.fromValues(
		under.r + (over.r - under.r) * amount,
		under.g + (over.g - under.g) * amount,
		under.b + (over.b - under.b) * amount,
		1,
	);
};

// One file a call changed, through OpenTUI's DiffRenderable, the way opencode's
// component/patch-diff.tsx draws an edit: unified, or split side by side on a wide screen, with line
// numbers in a gutter wide enough for the last one. Held to DIFF_ROWS lines of its hunks.
const FileDiff = ({
	diff,
	named,
	split,
}: {
	diff: ActivityDiff;
	named: boolean;
	split: boolean;
}): ReactNode => {
	const theme = useTheme();
	const syntaxStyle = useMarkdownStyle();
	const bg = theme.surface.raised;
	const { patch, cut } = useMemo(() => ToolRows.patch(diff, DIFF_ROWS), [diff]);
	const colors = useMemo(
		() => ({
			added: tint(theme.done, bg, DIFF_TINT),
			removed: tint(theme.failed, bg, DIFF_TINT),
		}),
		[theme, bg],
	);
	const last = Math.max(
		1,
		...[
			...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
		].flatMap((match) => [
			Number(match[1]) + Number(match[2] ?? 1) - 1,
			Number(match[3]) + Number(match[4] ?? 1) - 1,
		]),
	);
	return (
		<box style={{ flexDirection: "column", flexShrink: 0 }}>
			{named ? (
				<text bg={bg} fg={theme.muted} wrapMode="none" truncate>
					{diff.path}
				</text>
			) : null}
			{patch === "" ? (
				<text bg={bg} fg={theme.muted}>
					no change
				</text>
			) : (
				<diff
					diff={patch}
					view={split ? "split" : "unified"}
					syntaxStyle={syntaxStyle}
					showLineNumbers
					wrapMode="word"
					fg={theme.text}
					contextBg={bg}
					addedBg={colors.added}
					removedBg={colors.removed}
					addedSignColor={theme.done}
					removedSignColor={theme.failed}
					lineNumberFg={theme.muted}
					lineNumberBg={bg}
					addedLineNumberBg={colors.added}
					removedLineNumberBg={colors.removed}
					gutter={{ paddingLeft: 0, minDigits: String(last).length }}
					style={{ width: "100%", flexShrink: 0 }}
				/>
			)}
			{cut > 0 ? (
				<text bg={bg} fg={theme.muted}>
					{`(${cut} more ${cut === 1 ? "line" : "lines"})`}
				</text>
			) : null}
		</box>
	);
};
