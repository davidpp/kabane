/** @jsxImportSource @opentui/react */
// Event view: the event log behind one activity card, read through ActivitySource.events. Polls at
// 1s while the card is in flight, appending events incrementally. Auto-scrolls when pinned to the
// bottom; stops yanking if the user scrolled up.

import type { ScrollBoxRenderable } from "@opentui/core";
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
import {
	type ActivityCard,
	type ActivityEvent,
	type ActivitySource,
	isInFlight,
} from "./ports";

const MUTED_COLOR = "#6b7280";
const ACCENT_COLOR = "#f97316";
const ERROR_COLOR = "#ef4444";
const COMPLETED_COLOR = "#22c55e";
const POLL_MS = 1000;

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
	// Extra footer hints for this card (the copilot's `x cancel`); the scroll/back pair is always there.
	extraHints?: string;
};

export const EventView = ({
	cardId,
	initialCard,
	source,
	resolveShortId,
	scrollRef,
	notice,
	extraHints,
}: EventViewProps): ReactNode => {
	const [card, setCard] = useState<ActivityCard | null>(initialCard ?? null);
	const [events, setEvents] = useState<ActivityEvent[]>([]);
	const lastSeqRef = useRef(0);

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

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text>
				<span fg={statusColor(card.status)}>{header}</span>
			</text>
			<scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }}>
				{events.length === 0 ? (
					<text fg={MUTED_COLOR}>no events yet</text>
				) : (
					events.map((event) => {
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
