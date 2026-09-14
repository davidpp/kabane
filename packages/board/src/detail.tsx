/** @jsxImportSource @opentui/react */
// Detail view for a single task: the folded agent brief (BoardData.taskBrief → Planner.assembleContext)
// rendered as scrollable markdown. Header shows shortId + title; the scrollbox is driven by app.tsx's
// `scroll` effect (it owns the ref so all keys stay in the one useKeyboard handler). Two fallbacks to
// plain text: a Result error (show the message) and a markdown render throw (show the raw brief, via
// the ErrorBoundary) — the view never crashes the app.
import type { Task, TaskComment } from "@cabane/core";
import {
	type ScrollBoxRenderable,
	SyntaxStyle,
	TextAttributes,
} from "@opentui/core";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import type { BoardActivity } from "./activity";
import { BoardData } from "./data";
import { ErrorBoundary } from "./error-boundary";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import type { ActivityCard, ActivityStatus } from "./ports";
import { RUNNING_ECHO, SPINNER_IDLE } from "./spinner";

const HINT_COLOR = "#6b7280";
const ERROR_COLOR = "#ef4444";
// The one accent — flashed on the [copy] button and the success notice; muted otherwise.
const ACCENT_COLOR = "#f97316";

// SyntaxStyle allocates a native FFI handle — build ONE for the process, never per render.
const SYNTAX_STYLE = SyntaxStyle.fromStyles({
	"markup.heading": { fg: "#58a6ff", bold: true },
	"markup.heading.1": { fg: "#58a6ff", bold: true },
	"markup.heading.2": { fg: "#58a6ff", bold: true },
	"markup.list": { fg: "#f97316" },
	"markup.raw": { fg: "#a5d6ff" },
	"markup.bold": { bold: true },
	"markup.italic": { italic: true },
	default: { fg: "#e6edf3" },
});

// The header already shows `shortId · title`, and the brief (assembleContext) opens with the same
// title as its `# ` heading — showing both reads as a bug. Strip that first heading (and the blank
// line under it) before the markdown render; anything else passes through untouched. Exported pure
// for tests.
export const stripTitleHeading = (content: string): string => {
	const lines = content.split("\n");
	let i = 0;
	while (i < lines.length && lines[i]?.trim() === "") i++;
	if (!lines[i]?.startsWith("# ")) return content;
	i++;
	if (lines[i]?.trim() === "") i++;
	return lines.slice(i).join("\n");
};

// `content` in `failed` is the plain text to render — the error message on a Result failure.
type BriefState =
	| { status: "loading" }
	| { status: "ready"; content: string }
	| { status: "failed"; content: string };

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

// Status color for a card glyph.
const cardGlyphColor = (status: ActivityStatus): string => {
	switch (status) {
		case "running":
		case "pending":
			return ACCENT_COLOR;
		case "completed":
			return "#22c55e"; // green
		case "failed":
			return ERROR_COLOR;
		case "paused":
			return HINT_COLOR;
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

// One-line text for a card row in the activity block: `⠹ scout · running · 2m14s`.
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
	basePath: string;
	taskId: string;
	// The selected task, for the header. Absent (e.g. filtered out on a poll) → fall back to the id.
	task?: Task;
	// Host activity cards for this task (BoardActivity, refreshed by app.tsx's poll): the first
	// in-flight one is the status line under the header; all of them list in the activity block.
	cards?: ActivityCard[];
	// Task comments — rendered as a section above the brief.
	comments?: TaskComment[];
	// Unanswered questions parked on this task — rendered above the brief so what's blocked on the
	// human is the first thing they see. Answering happens via the CLI, not the board (yet).
	questions?: BoardActivity.AwaitingQuestion[];
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
	// This task points at an issue in an external tracker, so `O` has somewhere to go. WHICH issue is
	// already in the brief below (assembleContext writes it), so this only gates the footer hint.
	linked?: boolean;
	// Clicking the header [copy] affordance yanks the brief — same action as the `y` key.
	onCopy?: () => void;
};

// Markdown render is the one place a throw can reach the app; wrap it so a parse failure degrades to
// the raw brief as plain text instead of tearing down the tree.
const BriefBody = ({ content }: { content: string }): ReactNode => (
	<ErrorBoundary fallback={<text>{content}</text>}>
		<markdown content={content} syntaxStyle={SYNTAX_STYLE} />
	</ErrorBoundary>
);

export const Detail = ({
	basePath,
	taskId,
	task,
	cards,
	comments,
	questions,
	spinnerFrame,
	scrollRef,
	notice,
	focus = "board",
	pane,
	linked = false,
	onCopy,
}: DetailProps): ReactNode => {
	const [brief, setBrief] = useState<BriefState>({ status: "loading" });

	// biome-ignore lint/correctness/useExhaustiveDependencies: task?.updatedAt is an intentional trigger — a v/x/n/s mutation on the open task re-fetches the brief without changing taskId.
	useEffect(() => {
		let cancelled = false;
		setBrief({ status: "loading" });
		void (async () => {
			const result = await BoardData.taskBrief(basePath, taskId);
			if (cancelled) return;
			setBrief(
				result.ok
					? { status: "ready", content: result.value }
					: { status: "failed", content: result.error.message },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [basePath, taskId, task?.updatedAt]);

	const shortId = task?.shortId ?? taskId.slice(0, 8);
	const header = [shortId, task?.title].filter(Boolean).join(" · ");
	const headline = cards?.find(
		(c) =>
			c.status === "running" || c.status === "pending" || c.status === "paused",
	);
	const detailHints = [
		...(linked ? [Keymap.OPEN_LINK_HINT] : []),
		...(cards?.some((c) => c.hasEvents)
			? [{ key: "o", label: "events" }, ...Keymap.DETAIL_FOOTER]
			: Keymap.DETAIL_FOOTER),
	];
	const hints = Keymap.hintLine(
		focus === "copilot" ? Keymap.COPILOT_FOOTER : detailHints,
	);

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<box style={{ flexDirection: "row" }}>
				<text attributes={TextAttributes.BOLD} style={{ flexGrow: 1 }}>
					{header}
				</text>
				<text
					fg={notice?.tone === "success" ? ACCENT_COLOR : HINT_COLOR}
					onMouseDown={onCopy}
				>
					[copy]
				</text>
			</box>
			{/* Boxed, not a bare <text>: a bare text sibling after the header row-box paints over row 0. */}
			{headline ? (
				<box style={{ flexDirection: "row", flexShrink: 0 }}>
					<text fg={headline.stale ? HINT_COLOR : ACCENT_COLOR}>
						{cardStatusLine(headline, spinnerFrame)}
					</text>
				</box>
			) : null}
			<scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }}>
				{cards && cards.length > 0 ? (
					<box style={{ flexDirection: "column", marginBottom: 1 }}>
						<text fg={HINT_COLOR} attributes={TextAttributes.BOLD}>
							activity
						</text>
						{cards.map((card) => (
							<text key={card.id} fg={cardGlyphColor(card.status)}>
								{"  "}
								{cardRowLine(card, spinnerFrame)}
							</text>
						))}
					</box>
				) : null}
				{questions && questions.length > 0 ? (
					<box style={{ flexDirection: "column", marginBottom: 1 }}>
						{questions.map((q) => (
							<text key={q.questionActivityId} fg={HINT_COLOR}>
								? awaiting input: {q.question}
							</text>
						))}
						<text fg={HINT_COLOR}>answer: cabane needs-input</text>
					</box>
				) : null}
				{comments && comments.length > 0 ? (
					<box style={{ flexDirection: "column", marginBottom: 1 }}>
						<text fg={HINT_COLOR} attributes={TextAttributes.BOLD}>
							comments ({comments.length})
						</text>
						{comments.map((c) => (
							<text
								key={c.id}
								fg={c.authorType === "human" ? "#e6edf3" : HINT_COLOR}
							>
								{"  "}
								{c.author} · {relativeTime(c.createdAt)}:{" "}
								{c.content.split("\n")[0]}
							</text>
						))}
					</box>
				) : null}
				{brief.status === "loading" ? (
					<text fg={HINT_COLOR}>Loading brief…</text>
				) : brief.status === "failed" ? (
					<text fg={ERROR_COLOR}>{brief.content}</text>
				) : (
					<BriefBody content={stripTitleHeading(brief.content)} />
				)}
			</scrollbox>
			{pane}
			{notice ? (
				<StatusBar
					text={notice.undoable ? `${notice.text} · ⌃z undo` : notice.text}
					fg={notice.tone === "success" ? ACCENT_COLOR : ERROR_COLOR}
				/>
			) : (
				<StatusBar text={hints} fg={HINT_COLOR} />
			)}
		</box>
	);
};
