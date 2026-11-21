/** @jsxImportSource @opentui/react */
import type { ActivityCard, ActivityEvent } from "@kabane/extension";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useMemo, type ReactNode, type RefObject } from "react";
import { Cockpit } from "./cockpit";
import { took } from "./elapsed";
import { eventStyle } from "./event-style";
import { isInFlight } from "./ports";
import { Segments } from "./segments";
import { Theme, useTheme } from "./theme";
import { ToolRows } from "./tool-rows";

type Line = Pick<ActivityEvent, "lane" | "type" | "summary" | "severity"> & {
	at?: string;
	durationMs?: number;
};
type Fold = { calls: ToolRows.Call[] };
const VISIBLE = new Set([
	"text",
	"thought",
	"phase",
	"permission",
	"warning",
	"notice",
	"error",
]);
const isFold = (row: Line | Fold): row is Fold => "calls" in row;

const folded = ({ calls }: Fold): Line => {
	const first = calls[0];
	const failures = calls.filter((c) => c.status === "failed").length;
	const running = calls.some((c) => c.status === "running");
	const start = Date.parse(first?.at ?? "");
	const end = calls.reduce(
		(last, c) => (c.endedAt ? Math.max(last, Date.parse(c.endedAt)) : last),
		-Infinity,
	);
	const summary = [
		`${calls.length} ${calls.length === 1 ? "tool" : "tools"}`,
		...(failures ? [`${failures} failed`] : []),
		...(end >= start ? [took(end - start)] : []),
	].join(" · ");
	return {
		lane: first?.lane,
		at: first?.at,
		type: running ? "running-tools" : "tools",
		summary,
	};
};

// A fold owns its first call's row. Only something said on its own lane closes it.
export const nowLines = (
	events: readonly ActivityEvent[],
	lanes: readonly string[],
): Line[] => {
	if (!lanes.length) return events.filter((e) => e.run);
	const selected = events.filter(
		(e) => e.lane !== undefined && lanes.includes(e.lane),
	);
	const rows: (Line | Fold)[] = [];
	const folds = new Map<string, Fold>();
	for (const row of ToolRows.rows(selected, true)) {
		if (row.type === "event") {
			if (row.event.lane && VISIBLE.has(row.event.type)) {
				folds.delete(row.event.lane);
				rows.push(row.event);
			}
			continue;
		}
		const calls = row.type === "group" ? row.group.calls : [row.call];
		const lane = calls[0]?.lane;
		if (lane === undefined) continue;
		if (row.type === "call" && row.call.unmatchedResult) {
			folds.delete(lane);
			rows.push({
				lane,
				at: row.call.at,
				type: row.call.status === "failed" ? "error" : "done",
				summary: row.call.summary,
			});
			continue;
		}
		let fold = folds.get(lane);
		if (!fold) {
			fold = { calls: [] };
			folds.set(lane, fold);
			rows.push(fold);
		}
		fold.calls.push(...calls);
	}
	return rows.map((row) => (isFold(row) ? folded(row) : row));
};

export const trace = (
	card: ActivityCard,
	events: readonly ActivityEvent[],
): Line[] => {
	const lines: Line[] = [];
	for (const step of card.steps ?? []) {
		if (step.state === "pending") continue;
		lines.push({
			durationMs: step.durationMs,
			type: step.state === "failed" ? "error" : step.state,
			summary: [step.name, step.result].filter(Boolean).join(" · "),
		});
	}
	const finishedAt = card.finishedAt;
	if (finishedAt)
		lines.push(...events.filter((e) => e.run && e.at >= finishedAt));
	return lines;
};

const shortTags = (
	card: ActivityCard,
	lanes: readonly string[],
): Map<string, string> => {
	const tags = new Map<string, string>();
	const used = new Set<string>();
	const sessions = card.steps?.flatMap((step) => step.sessions ?? []);
	for (const lane of lanes) {
		const name = sessions?.find((s) => s.lane === lane)?.name ?? lane;
		const issue = /(?:^|:)([A-Z][A-Z0-9]*-\d+(?:#\d+)?)$/.exec(name)?.[1];
		const prefix =
			(issue && issue.length > 10 ? issue.slice(-10) : issue) ??
			(name.length > 8 ? name.slice(0, 4) : name);
		let tag = prefix;
		for (let n = 2; used.has(tag); n++) tag = prefix + n;
		tags.set(lane, tag);
		used.add(tag);
	}
	return tags;
};

const EMPTY: readonly string[] = [];
export const orderedLiveLanes = (
	card: Pick<ActivityCard, "lanes" | "liveLanes">,
): readonly string[] => {
	const live = card.liveLanes ?? EMPTY;
	return card.lanes?.filter((lane) => live.includes(lane)) ?? live;
};
// The feed fills the rows down to the footer, keeping at least NOW_MIN_ROWS of them; with `rows`, a
// log sits under it, and it takes as many rows as it has lines up to `rows`.
export const NowFeed = ({
	card,
	events,
	width,
	spinnerFrame,
	scrollRef,
	rows,
}: {
	card: ActivityCard;
	events: readonly ActivityEvent[];
	width: number;
	spinnerFrame: string;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	rows?: number;
}): ReactNode => {
	const theme = useTheme();
	const live = isInFlight(card);
	const lanes = useMemo(() => orderedLiveLanes(card), [card]);
	const lines = useMemo(
		() => (live ? nowLines(events, lanes) : trace(card, events)),
		[live, events, lanes, card],
	);
	const hues = useMemo(
		() => Theme.liveHues(theme, card.lanes ?? lanes, lanes),
		[theme, card.lanes, lanes],
	);
	const tags = shortTags(card, lanes.length > 1 ? lanes : EMPTY);
	const cols = Math.max(0, ...Array.from(tags.values(), (tag) => tag.length));
	// A basis rather than a height: OpenTUI drops a box's shrink once its numeric height changes.
	const shown = Math.max(1, lines.length);
	const size =
		rows === undefined
			? { flexGrow: 1, flexBasis: 0, minHeight: 1 + Cockpit.NOW_MIN_ROWS }
			: {
					flexGrow: 0,
					flexBasis: 1 + Math.min(shown, rows),
					minHeight: 1 + Math.min(shown, Cockpit.NOW_MIN_ROWS),
				};
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 1,
				marginTop: 1,
				...size,
			}}
		>
			<text attributes={TextAttributes.BOLD}>{live ? "now" : "run trace"}</text>
			<scrollbox
				ref={scrollRef}
				stickyScroll
				stickyStart="bottom"
				style={{ flexGrow: 1 }}
			>
				{lines.length === 0 && <text fg={theme.muted}>no events yet</text>}
				{lines.map((line, index) => {
					const style = eventStyle(line, theme);
					const running = line.type === "running-tools";
					const tag = line.lane && tags.get(line.lane);
					const parts = [];
					if (width >= 60 || !live)
						parts.push({
							text:
								(line.durationMs !== undefined
									? took(line.durationMs)
									: line.at
										? new Date(line.at).toTimeString().slice(0, 5)
										: ""
								).padStart(live ? 5 : 6) + " ",
							fg: theme.muted,
						});
					if (tag && line.lane)
						parts.push({
							text: tag.padEnd(cols) + " ",
							fg: hues.get(line.lane) ?? theme.secondary,
						});
					const glyph = running
						? spinnerFrame
						: line.type === "tools"
							? "▸"
							: line.type === "stopped"
								? "⏹"
								: style.glyph;
					parts.push({
						text: glyph + " ",
						fg: running ? theme.working : style.glyphFg,
					});
					const [head = "", ...rest] = line.summary.trim().split("\n");
					const heading =
						line.type === "thought" ? head.replace(/^#+\s+|\*\*/g, "") : head;
					parts.push({
						text: heading + (rest.length && line.type !== "thought" ? "…" : ""),
						fg: line.type === "permission" ? theme.accent : style.textFg,
					});
					return (
						<text key={index} wrapMode="none">
							{Segments.spans(Segments.fit(parts, width - 2))}
						</text>
					);
				})}
			</scrollbox>
		</box>
	);
};
