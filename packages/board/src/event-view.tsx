/** @jsxImportSource @opentui/react */
// Event view: the event log behind one activity card, read through ActivitySource.events. Polls at
// 1s while the card is in flight, appending events incrementally. Auto-scrolls when pinned to the
// bottom; stops yanking if the user scrolled up.
//
// Two things are not rows: a plan, which heads the view pinned outside the scrollbox, and a `prompt`
// event, which is what was ASKED and so opens the turn that answers it as a block of its own, on the
// raised surface (opencode's user-message block, without its bar: DESIGN.md's No-Line Rule).

import {
	type ColorInput,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { elapsed } from "./elapsed";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import { PermissionBlock } from "./permission-block";
import { PlanBlock } from "./plan-block";
import {
	type ActivityCard,
	type ActivityEvent,
	type ActivitySource,
	type CardHeader,
	type CopilotPermission,
	isInFlight,
	type PlanEntry,
	PROMPT_EVENT,
} from "./ports";
import { useSpinnerFrame } from "./spinner";
import { Theme, useTheme } from "./theme";

const POLL_MS = 1000;
// The transcript has the whole screen where the copilot panel has a dozen rows, so its pinned block
// can be taller — never tall enough to push the events it heads out of view.
const MAX_PLAN_ROWS = 8;
// The glyph and a cell to spare, reserved out of the row before an entry is fitted, and the floor
// below which fitting stops (a narrow frame gets a wrapped entry rather than an ellipsis alone).
const RESERVED_COLS = 3;
const MIN_ENTRY_COLS = 20;

const NO_PLAN: readonly PlanEntry[] = [];

// The prompt block: its padding either side, the scrollbar and a cell to spare come out of the row,
// and it is held to a few rows so a long pasted prompt heads its turn rather than burying it.
const PROMPT_CHROME_COLS = 4;
const MAX_PROMPT_ROWS = 3;

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

// A harness names a call `Read src/app.tsx` or `mcp__kabane__kabane_list`: the tool, then what it was
// called on. Split there, so the tool reads in the text color and its arguments as an aside. A title
// that does not open on a tool-shaped word (a quoted shell command) stays whole.
export const toolParts = (summary: string): { name: string; args: string } => {
	const match = /^([A-Za-z][\w.:-]*)\s+(.+)$/s.exec(summary.trim());
	return match
		? { name: match[1] ?? summary, args: match[2] ?? "" }
		: { name: summary.trim(), args: "" };
};

// Per-event-type glyph and text colors. Types are host-defined strings; the common ones get a glyph,
// the rest a blank. The glyph carries the hue (DESIGN.md's glyph table): work that ran is the working
// hue, a question the accent, a failure the failed hue, the rest muted. The agent's own words carry
// no hue: they read on the terminal's foreground, dark or light; its thoughts are dimmed under them.
// An ACP host names a call `tool_call` and its end `tool_completed`/`tool_failed`, which read as the
// copilot's `tool_use`/`tool_result` and as an error.
const eventStyle = (
	type: string,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	switch (type) {
		case "text":
			return { glyph: " ", glyphFg: theme.defaultFg, textFg: theme.defaultFg };
		case "thought":
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
		case "tool_use":
		case "tool_call":
			return { glyph: "⚙", glyphFg: theme.working, textFg: theme.defaultFg };
		case "tool_result":
		case "tool_completed":
			return { glyph: "←", glyphFg: theme.muted, textFg: theme.muted };
		case "tool_failed":
			return { glyph: "✗", glyphFg: theme.failed, textFg: theme.muted };
		case "phase":
			return { glyph: "▶", glyphFg: theme.working, textFg: theme.defaultFg };
		case "progress":
			return { glyph: "·", glyphFg: theme.muted, textFg: theme.muted };
		case "permission":
			return { glyph: "?", glyphFg: theme.accent, textFg: theme.defaultFg };
		case "error":
			return { glyph: "✗", glyphFg: theme.failed, textFg: theme.failed };
		case "metric":
			return { glyph: "$", glyphFg: theme.muted, textFg: theme.muted };
		default:
			return { glyph: " ", glyphFg: theme.muted, textFg: theme.muted };
	}
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
	permission?: CopilotPermission | null;
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

/** Polls the card and its events: every second while it is in flight, once when it is over. */
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
	}, [cardId, source]);
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
	permission,
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
			/>
			{permission ? (
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
						request={permission}
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
// its lane's tag in the lane's series color, the same one its chip has.
const Stream = ({
	card,
	events,
	lanes,
	width,
	scrollRef,
	tabbed,
}: {
	card: ActivityCard;
	events: readonly ActivityEvent[];
	lanes: readonly string[];
	width: number;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	tabbed: boolean;
}): ReactNode => {
	const theme = useTheme();
	const cols = lanes.length > 0 ? tagCols(lanes, width) : 0;
	const promptRoom = Math.max(
		MIN_ENTRY_COLS,
		width - PROMPT_CHROME_COLS - (cols > 0 ? cols + 1 : 0),
	);
	const tagOf = (event: ActivityEvent): Tag | undefined => {
		if (cols === 0 || event.lane === undefined) return undefined;
		return {
			text: fit(event.lane, cols).padEnd(cols),
			fg: Theme.seriesOf(theme, Math.max(0, lanes.indexOf(event.lane))),
		};
	};
	return (
		<scrollbox
			ref={scrollRef}
			stickyScroll={tabbed}
			stickyStart="bottom"
			style={{ flexGrow: 1, marginTop: 1 }}
		>
			{events.length === 0 ? (
				<text fg={theme.muted}>no events yet</text>
			) : (
				events.map((event, index) =>
					event.type === PROMPT_EVENT ? (
						<PromptBlock
							key={event.seq}
							lines={promptLines(event.summary, promptRoom, MAX_PROMPT_ROWS)}
							first={index === 0}
							tag={tagOf(event)}
						/>
					) : (
						<EventRow key={event.seq} event={event} tag={tagOf(event)} />
					),
				)
			)}
			<Ending card={card} />
		</scrollbox>
	);
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
	const { glyph, glyphFg, textFg } = eventStyle(event.type, theme);
	const tool =
		event.type === "tool_use" || event.type === "tool_call"
			? toolParts(event.summary)
			: null;
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
			<text
				fg={textFg}
				attributes={event.type === "thought" ? TextAttributes.ITALIC : 0}
				style={{ flexGrow: 1, flexShrink: 1 }}
			>
				{tool ? (
					<>
						{tool.name}
						{tool.args ? (
							<span fg={theme.muted} attributes={TextAttributes.ITALIC}>
								{` ${tool.args}`}
							</span>
						) : null}
					</>
				) : (
					event.summary
				)}
			</text>
		</box>
	);
};
