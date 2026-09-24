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
	type CopilotPermission,
	isInFlight,
	type PlanEntry,
	PROMPT_EVENT,
} from "./ports";
import { useSpinnerFrame } from "./spinner";
import { type Theme, useTheme } from "./theme";

const POLL_MS = 1000;
// The transcript has the whole screen where the copilot panel has a dozen rows, so its pinned block
// can be taller — never tall enough to push the events it heads out of view.
const MAX_PLAN_ROWS = 8;
// Timestamp column plus the glyph, reserved out of the row before an entry is fitted, and the floor
// below which fitting stops (a narrow frame gets a wrapped entry rather than an ellipsis alone).
const RESERVED_COLS = 12;
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
// no hue: they read on the terminal's foreground, dark or light.
const eventStyle = (
	type: string,
	theme: Theme.Tokens,
): { glyph: string; glyphFg: ColorInput; textFg: ColorInput } => {
	switch (type) {
		case "text":
			return { glyph: " ", glyphFg: theme.defaultFg, textFg: theme.defaultFg };
		case "tool_use":
			return { glyph: "⚙", glyphFg: theme.working, textFg: theme.defaultFg };
		case "tool_result":
			return { glyph: "←", glyphFg: theme.muted, textFg: theme.muted };
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
	// Subtracted from the row width when the sidebar is up, so a long plan entry is fitted to what the
	// view actually has rather than wrapping into a second line.
	sidebarWidth?: number;
	// The copilot pane, rendered between the content and the footer. A slot rather than a float: the
	// panel has real height and must push the view up, not cover it.
	pane?: ReactNode;
};

const TRANSCRIPT_KEYS: Keymap.Live = { context: "transcript", situation: {} };

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
	sidebarWidth = 0,
	pane,
}: EventViewProps): ReactNode => {
	const [card, setCard] = useState<ActivityCard | null>(initialCard ?? null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const lastSeqRef = useRef(0);
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	const spinnerFrame = useSpinnerFrame(card ? isInFlight(card) : false);

	// Initial load + poll. Stops polling once the card reaches a terminal state.
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		let cancelled = false;
		const poll = async (): Promise<void> => {
			if (source.card) {
				const refreshed = await source.card(cardId);
				if (cancelled) return;
				if (refreshed.ok && refreshed.value) {
					setCard(refreshed.value);
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

	if (!card) {
		return (
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<text fg={theme.muted}>loading…</text>
			</box>
		);
	}

	const shortId =
		card.taskShortId ??
		(card.taskId ? (resolveShortId(card.taskId) ?? "—") : "—");
	const duration = elapsed(card.startedAt, card.finishedAt);
	const hints = Keymap.footer(keys.context, keys.situation);
	const contentWidth = Math.max(
		MIN_ENTRY_COLS,
		width - sidebarWidth - RESERVED_COLS,
	);
	const promptRoom = Math.max(
		MIN_ENTRY_COLS,
		width - sidebarWidth - PROMPT_CHROME_COLS,
	);

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text>
				<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
					{card.label}
				</span>
				<span fg={theme.muted}>{` · ${shortId} · `}</span>
				<span fg={statusColor(card.status, theme)}>{card.status}</span>
				<span fg={theme.muted}>{` · ${duration}`}</span>
			</text>
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
			<scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }}>
				{events.length === 0 ? (
					<text fg={theme.muted}>no events yet</text>
				) : (
					events.map((event, index) =>
						event.type === PROMPT_EVENT ? (
							<PromptBlock
								key={event.seq}
								lines={promptLines(event.summary, promptRoom, MAX_PROMPT_ROWS)}
								first={index === 0}
							/>
						) : (
							<EventRow key={event.seq} event={event} />
						),
					)
				)}
				{card.status === "completed" ? (
					<box style={{ marginTop: 1 }}>
						<text fg={theme.done}>completed · {duration}</text>
					</box>
				) : null}
				{card.status === "failed" && card.error ? (
					<box style={{ marginTop: 1 }}>
						<text fg={theme.failed}>failed: {card.error}</text>
					</box>
				) : null}
			</scrollbox>
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

// The prompt a turn opened with, on the raised surface across the row. A gap above parts it from the
// turn before; the first turn needs none, the header's own gap already stands there.
const PromptBlock = ({
	lines,
	first,
}: {
	lines: readonly string[];
	first: boolean;
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
					{line}
				</text>
			))}
		</box>
	);
};

// One event: the time and the glyph hold their columns, and the text wraps beside them with a
// hanging indent, so an agent's paragraph reads as a paragraph instead of restarting at column 0.
const EventRow = ({ event }: { event: ActivityEvent }): ReactNode => {
	const theme = useTheme();
	const { glyph, glyphFg, textFg } = eventStyle(event.type, theme);
	const time = new Date(event.at).toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const tool = event.type === "tool_use" ? toolParts(event.summary) : null;
	return (
		<box style={{ flexDirection: "row", flexShrink: 0 }}>
			<text fg={theme.muted} style={{ flexShrink: 0 }}>
				{`${time} `}
			</text>
			<text fg={glyphFg} style={{ flexShrink: 0 }}>
				{`${glyph} `}
			</text>
			<text fg={textFg} style={{ flexGrow: 1, flexShrink: 1 }}>
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
