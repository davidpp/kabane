/** @jsxImportSource @opentui/react */
// Event view: the event log behind one activity card, read through ActivitySource.events. Polls at
// 1s while the card is in flight, appending events incrementally. Auto-scrolls when pinned to the
// bottom; stops yanking if the user scrolled up.
//
// Two things are not rows: a plan, which heads the view pinned outside the scrollbox, and a `prompt`
// event, which is what was ASKED and so is drawn as the rule opening the turn that answers it.

import type { ScrollBoxRenderable } from "@opentui/core";
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
import type { BoardNav } from "./nav";
import { PlanBlock } from "./plan-block";
import {
	type ActivityCard,
	type ActivityEvent,
	type ActivitySource,
	isInFlight,
	type PlanEntry,
	PROMPT_EVENT,
} from "./ports";
import { useSpinnerFrame } from "./spinner";

const MUTED_COLOR = "#6b7280";
const ACCENT_COLOR = "#f97316";
const ERROR_COLOR = "#ef4444";
const COMPLETED_COLOR = "#22c55e";
const POLL_MS = 1000;
// The transcript has the whole screen where the copilot panel has a dozen rows, so its pinned block
// can be taller — never tall enough to push the events it heads out of view.
const MAX_PLAN_ROWS = 8;
// Timestamp column plus the glyph, reserved out of the row before an entry is fitted, and the floor
// below which fitting stops (a narrow frame gets a wrapped entry rather than an ellipsis alone).
const RESERVED_COLS = 12;
const MIN_ENTRY_COLS = 20;

const NO_PLAN: readonly PlanEntry[] = [];

// `── split this into subtasks ─────`: the prompt that opened a turn, drawn as the rule that parts it
// from the turn before. The lead is `── ` and a space, and the tail never shrinks to nothing — a
// label with no rule after it reads as a stray line of text.
const RULE_LEAD_COLS = 4;
const MIN_RULE_TAIL = 3;

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

const promptRule = (
	prompt: string,
	width: number,
): { label: string; tail: string } => {
	const label = fit(
		prompt.split("\n")[0] ?? "",
		width - RULE_LEAD_COLS - MIN_RULE_TAIL,
	);
	return {
		label,
		tail: "─".repeat(
			Math.max(MIN_RULE_TAIL, width - label.length - RULE_LEAD_COLS),
		),
	};
};

// Per-event-type glyph. Types are host-defined strings; the common ones get a glyph, the rest a blank.
const eventGlyph = (type: string): { glyph: string; color: string } => {
	switch (type) {
		case "text":
			return { glyph: " ", color: "#c9d1d9" };
		case "tool_use":
			return { glyph: "⚙", color: ACCENT_COLOR };
		case "tool_result":
			return { glyph: "←", color: MUTED_COLOR };
		case "phase":
			return { glyph: "▶", color: ACCENT_COLOR };
		case "progress":
			return { glyph: "·", color: MUTED_COLOR };
		case "error":
			return { glyph: "✗", color: ERROR_COLOR };
		case "metric":
			return { glyph: "$", color: MUTED_COLOR };
		default:
			return { glyph: " ", color: MUTED_COLOR };
	}
};

// Status color for the header.
const statusColor = (status: string): string => {
	switch (status) {
		case "running":
		case "pending":
			return ACCENT_COLOR;
		case "completed":
			return COMPLETED_COLOR;
		case "failed":
			return ERROR_COLOR;
		default:
			return MUTED_COLOR;
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
	// Extra footer hints for this card (the copilot's `x cancel`); the scroll/back pair is always there.
	extraHints?: string;
	// Subtracted from the row width when the sidebar is up, so a long plan entry is fitted to what the
	// view actually has rather than wrapping into a second line.
	sidebarWidth?: number;
	// The copilot pane, rendered between the content and the footer. A slot rather than a float: the
	// panel has real height and must push the view up, not cover it.
	pane?: ReactNode;
};

export const EventView = ({
	cardId,
	initialCard,
	source,
	resolveShortId,
	scrollRef,
	notice,
	plan = NO_PLAN,
	extraHints,
	sidebarWidth = 0,
	pane,
}: EventViewProps): ReactNode => {
	const [card, setCard] = useState<ActivityCard | null>(initialCard ?? null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const lastSeqRef = useRef(0);
	const { width } = useTerminalDimensions();
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
				<text fg={MUTED_COLOR}>Loading…</text>
			</box>
		);
	}

	const shortId =
		card.taskShortId ??
		(card.taskId ? (resolveShortId(card.taskId) ?? "—") : "—");
	const duration = elapsed(card.startedAt, card.finishedAt);
	const header = `${card.label} · ${shortId} · ${card.status} · ${duration}`;
	const hints = ["j/k scroll", extraHints, "esc back"]
		.filter(Boolean)
		.join(" · ");
	const contentWidth = Math.max(
		MIN_ENTRY_COLS,
		width - sidebarWidth - RESERVED_COLS,
	);

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text>
				<span fg={statusColor(card.status)}>{header}</span>
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
					<text fg={MUTED_COLOR}>no events yet</text>
				) : (
					events.map((event) => {
						if (event.type === PROMPT_EVENT) {
							const { label, tail } = promptRule(event.summary, contentWidth);
							return (
								<box key={event.seq} style={{ marginTop: 1 }}>
									<text fg={MUTED_COLOR}>
										{"── "}
										<span fg={ACCENT_COLOR}>{label}</span>
										{` ${tail}`}
									</text>
								</box>
							);
						}
						const { glyph, color } = eventGlyph(event.type);
						const time = new Date(event.at).toLocaleTimeString("en-US", {
							hour12: false,
							hour: "2-digit",
							minute: "2-digit",
							second: "2-digit",
						});
						return (
							<text key={event.seq} fg={color}>
								<span fg={MUTED_COLOR}>{time} </span>
								{glyph} {event.summary}
							</text>
						);
					})
				)}
				{card.status === "completed" ? (
					<box style={{ marginTop: 1 }}>
						<text fg={COMPLETED_COLOR}>completed · {duration}</text>
					</box>
				) : null}
				{card.status === "failed" && card.error ? (
					<box style={{ marginTop: 1 }}>
						<text fg={ERROR_COLOR}>failed: {card.error}</text>
					</box>
				) : null}
			</scrollbox>
			{pane}
			{notice ? (
				<StatusBar
					text={notice.text}
					fg={notice.tone === "success" ? ACCENT_COLOR : ERROR_COLOR}
				/>
			) : (
				<StatusBar text={hints} fg={MUTED_COLOR} />
			)}
		</box>
	);
};
