/** @jsxImportSource @opentui/react */
// Event view: the event log behind one activity card, read through ActivitySource.events. Polls at
// 1s while the card is in flight, appending events incrementally. Auto-scrolls when pinned to the
// bottom; stops yanking if the user scrolled up.
//
// Two things are not rows: a plan, which heads the view pinned outside the scrollbox, and a `prompt`
// event, which is what was ASKED and so is drawn as the rule opening the turn that answers it.

import type { ColorInput, ScrollBoxRenderable } from "@opentui/core";
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
// The agent's own text carries no colour: it reads on the terminal's foreground, dark or light.
const eventGlyph = (
	type: string,
	theme: Theme.Tokens,
): { glyph: string; color: ColorInput } => {
	switch (type) {
		case "text":
			return { glyph: " ", color: theme.defaultFg };
		case "tool_use":
			return { glyph: "⚙", color: theme.accent };
		case "tool_result":
			return { glyph: "←", color: theme.muted };
		case "phase":
			return { glyph: "▶", color: theme.accent };
		case "progress":
			return { glyph: "·", color: theme.muted };
		case "permission":
			return { glyph: "?", color: theme.accent };
		case "error":
			return { glyph: "✗", color: theme.failed };
		case "metric":
			return { glyph: "$", color: theme.muted };
		default:
			return { glyph: " ", color: theme.muted };
	}
};

// Status color for the header.
const statusColor = (status: string, theme: Theme.Tokens): string => {
	switch (status) {
		case "running":
		case "pending":
			return theme.accent;
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
	permission,
	extraHints,
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
				<text fg={theme.muted}>Loading…</text>
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
			<text fg={theme.defaultFg}>
				<span fg={statusColor(card.status, theme)}>{header}</span>
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
					events.map((event) => {
						if (event.type === PROMPT_EVENT) {
							const { label, tail } = promptRule(event.summary, contentWidth);
							return (
								<box key={event.seq} style={{ marginTop: 1 }}>
									<text fg={theme.muted}>
										{"── "}
										<span fg={theme.accent}>{label}</span>
										{` ${tail}`}
									</text>
								</box>
							);
						}
						const { glyph, color } = eventGlyph(event.type, theme);
						const time = new Date(event.at).toLocaleTimeString("en-US", {
							hour12: false,
							hour: "2-digit",
							minute: "2-digit",
							second: "2-digit",
						});
						return (
							<text key={event.seq} fg={color}>
								<span fg={theme.muted}>{time} </span>
								{glyph} {event.summary}
							</text>
						);
					})
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
				<box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
					<PermissionBlock request={permission} width={contentWidth} />
				</box>
			) : null}
			{pane}
			{notice ? (
				<StatusBar
					text={notice.text}
					fg={notice.tone === "success" ? theme.accent : theme.failed}
				/>
			) : (
				<StatusBar text={hints} fg={theme.muted} />
			)}
		</box>
	);
};
