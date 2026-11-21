/** @jsxImportSource @opentui/react */
import type { ActivityCard, ActivityEvent } from "@kabane/extension";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import {
	useEffect,
	useMemo,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
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
	const spent = ToolRows.foldTime(calls);
	const summary = [
		`${calls.length} ${calls.length === 1 ? "tool" : "tools"}`,
		...(failures ? [`${failures} failed`] : []),
		...(spent !== undefined ? [spent] : []),
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

// A finished card's trace: the steps it reached, then the run's own events, from the whole run,
// that say something no step's row does (a subtask merged, a warning, the end). An event whose
// summary opens with a step's name is that step's (`gates · …`), and one another event `includes`
// was said by that one (a claim, by its session's start): their steps' rows already state them. A
// warning or an error stays whatever its words open with.
export const trace = (
	card: ActivityCard,
	events: readonly ActivityEvent[],
): Line[] => {
	const steps = card.steps ?? [];
	const lines: Line[] = [];
	for (const step of steps) {
		if (step.state === "pending") continue;
		lines.push({
			durationMs: step.durationMs,
			type: step.state === "failed" ? "error" : step.state,
			summary: [step.name, step.result].filter(Boolean).join(" · "),
		});
	}
	const included = new Set(events.flatMap((e) => e.includes ?? []));
	const stepOwns = (e: ActivityEvent): boolean =>
		e.type !== "warning" &&
		e.type !== "error" &&
		steps.some(
			(step) =>
				e.summary === step.name || e.summary.startsWith(`${step.name} `),
		);
	lines.push(
		...events.filter((e) => e.run && !included.has(e.seq) && !stepOwns(e)),
	);
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

/** The series slot each live lane was last drawn in, by lane (Theme.liveSlots). */
export type HueMemory = Map<string, number>;

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
	memory,
}: {
	card: ActivityCard;
	events: readonly ActivityEvent[];
	width: number;
	spinnerFrame: string;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
	rows?: number;
	// The live lanes' series slots as last drawn, kept by the card's view: "now" is remounted as the
	// cockpit's arrangement changes, and a session keeps its hue across that. Its own without one.
	memory?: HueMemory;
}): ReactNode => {
	const theme = useTheme();
	const [own] = useState(() => new Map<string, number>());
	const held = memory ?? own;
	const live = isInFlight(card);
	const lanes = useMemo(() => orderedLiveLanes(card), [card]);
	const lines = useMemo(
		() => (live ? nowLines(events, lanes) : trace(card, events)),
		[live, events, lanes, card],
	);
	const slots = useMemo(
		() =>
			Theme.liveSlots(theme.series.length, card.lanes ?? lanes, lanes, held),
		[theme.series.length, card.lanes, lanes, held],
	);
	useEffect(() => {
		held.clear();
		for (const [lane, slot] of slots) held.set(lane, slot);
	}, [held, slots]);
	const hues = useMemo(
		() =>
			new Map(
				[...slots].map(([lane, slot]) => [lane, Theme.seriesOf(theme, slot)]),
			),
		[slots, theme],
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
