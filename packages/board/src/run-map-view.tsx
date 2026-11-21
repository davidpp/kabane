/** @jsxImportSource @opentui/react */
// The map on a card's tab (DESIGN.md, "Run map"): one row per step, an open step's sessions under
// it, then what the card left for the human. Each row is its state's glyph, its name in a column,
// its result and its time; the cursor's row is on the selected surface behind a `›`. Narrower than
// WIDE_COLS, the time column goes and the finished steps the cursor is not on share one row.
//
// Rows come from RunMap, which the keys read too; this file only lays them out.
import type {
	ActivityLeft,
	ActivitySession,
	ActivityStep,
	ActivityStepState,
} from "@kabane/extension";
import {
	type BoxRenderable,
	type ColorInput,
	TextAttributes,
} from "@opentui/core";
import { type ReactNode, useState } from "react";
import { elapsed, took } from "./elapsed";
import { RunMap } from "./run-map";
import { type Theme, useTheme } from "./theme";

// From here the map has a time column and keeps each finished step on its own row.
const WIDE_COLS = 60;
const MAX_COLS = 100;
const TIME_COLS = 7;
// The name column never takes more than this share of the row, so a long session name leaves room
// for what it did.
const NAME_SHARE = 0.35;
const SESSION_INDENT = 2;
// A left item's reason needs this much room to say anything; with less, the row drops it.
const MIN_REASON_COLS = 12;
// A left issue with no short id shows this much of its id.
const ID_COLS = 10;

type Cell = { text: string; fg: ColorInput; bold?: boolean };
// One drawn row and the keys of the map rows it stands for: one, or several finished steps that
// share it. A key holds `+` in a grouped session's lane, so keys are compared whole.
type Line = { keys: readonly string[]; cells: Cell[] };

const cut = (text: string, room: number): string =>
	room <= 0
		? ""
		: text.length > room
			? `${text.slice(0, Math.max(0, room - 1))}…`
			: text;

/** A result held to `room`: whole ` · ` parts from the first, the first cut with `…` alone. */
const fitResult = (result: string, room: number): string => {
	const parts = result.split(" · ");
	while (parts.length > 1 && parts.join(" · ").length > room) parts.pop();
	return cut(parts.join(" · "), room);
};

const timeOf = (
	item: Pick<ActivityStep, "state" | "startedAt" | "durationMs">,
): string =>
	item.durationMs !== undefined
		? took(item.durationMs)
		: item.state === "running" && item.startedAt
			? elapsed(item.startedAt)
			: "";

const glyphOf = (
	state: ActivityStepState,
	session: boolean,
	spinnerFrame: string,
	theme: Theme.Tokens,
): Cell => {
	switch (state) {
		case "running":
			return session
				? { text: spinnerFrame, fg: theme.working }
				: { text: "●", fg: theme.working };
		case "done":
			return { text: "✓", fg: theme.done };
		case "failed":
			return { text: "✗", fg: theme.failed };
		case "stopped":
			return { text: "⏹", fg: theme.muted };
		case "pending":
			return { text: "○", fg: theme.muted };
	}
};

const ASKS: Cell["text"] = "?";

type Layout = {
	width: number;
	wide: boolean;
	nameCols: number;
	cursor: string | undefined;
	asking: ReadonlySet<string>;
	spinnerFrame: string;
	theme: Theme.Tokens;
};

const isAsking = (session: ActivitySession, asking: ReadonlySet<string>) =>
	session.lane !== undefined && asking.has(session.lane);

// A step or session row: gutter, glyph, name, result, time.
const itemLine = (
	row: Extract<RunMap.Row, { type: "step" | "session" }>,
	layout: Layout,
): Line => {
	const { theme, wide, width } = layout;
	const session = row.type === "session";
	const item = session ? row.session : row.step;
	const asks = session
		? isAsking(row.session, layout.asking)
		: (row.step.sessions ?? []).some((s) => isAsking(s, layout.asking));
	const glyph = asks
		? { text: ASKS, fg: theme.accent }
		: glyphOf(item.state, session, layout.spinnerFrame, theme);
	const indent = session ? SESSION_INDENT : 0;
	const name = cut(item.name, layout.nameCols - indent).padEnd(
		layout.nameCols - indent,
	);
	const time = timeOf(item);
	const timeCols = wide ? TIME_COLS : 0;
	// The glyph and its space, the name column (the indent is inside it), and the gap after it.
	const used = 2 + layout.nameCols + 2;
	const room = width - used - (timeCols > 0 ? timeCols + 1 : 0);
	const said = asks
		? ["asks you", item.result].filter(Boolean).join(" · ")
		: (item.result ?? "");
	const result = fitResult(said, room);
	// Narrow, the time stands in for a result the row has none of.
	const shownTime = wide
		? time.padStart(timeCols)
		: result === "" && time.length <= room
			? time
			: "";
	const pad = Math.max(
		0,
		width - used - result.length - (wide ? timeCols + 1 : shownTime.length),
	);
	return {
		keys: [row.key],
		cells: [
			{ text: " ".repeat(indent), fg: theme.defaultFg },
			{ ...glyph, text: `${glyph.text} ` },
			{
				text: `${name}  `,
				fg: item.state === "pending" ? theme.secondary : theme.defaultFg,
				bold: !session && item.state === "running",
			},
			{
				text: result,
				fg: asks ? theme.accent : theme.muted,
			},
			{
				text: `${" ".repeat(pad)}${wide ? " " : ""}${shownTime}`,
				fg: theme.muted,
			},
		],
	};
};

// Finished, folded steps side by side on one row: `✓ implement gates triage review fixer`.
// Finished, folded steps side by side, as many to a row as fit: `✓ implement gates triage review`.
const mergedLines = (
	steps: readonly ActivityStep[],
	keys: readonly string[],
	layout: Layout,
): Line[] => {
	const { theme } = layout;
	const room = layout.width - 2;
	const groups: { names: string[]; keys: string[] }[] = [];
	steps.forEach((step, at) => {
		const last = groups.at(-1);
		const key = keys[at] ?? "";
		if (last && [...last.names, step.name].join(" ").length <= room) {
			last.names.push(step.name);
			last.keys.push(key);
		} else groups.push({ names: [step.name], keys: [key] });
	});
	return groups.map((group) => ({
		keys: group.keys,
		cells: [
			{ text: "✓ ", fg: theme.done },
			{
				text: cut(group.names.join(" "), room).padEnd(room),
				fg: theme.defaultFg,
			},
		],
	}));
};

// An issue left for the human as the row names it: its short id, else the head of its id; a line
// with neither is not an issue.
const idOf = (item: ActivityLeft): string =>
	item.taskShortId ?? item.taskId?.slice(0, ID_COLS) ?? "";

const leftLine = (
	row: Extract<RunMap.Row, { type: "left" }>,
	idCols: number,
	howCols: number,
	layout: Layout,
): Line => {
	const { theme, width } = layout;
	const { item } = row;
	const id = idOf(item);
	if (id === "") {
		const text = cut(
			[item.how, item.reason].filter(Boolean).join(" · "),
			width,
		);
		return {
			keys: [row.key],
			cells: [{ text: text.padEnd(width), fg: theme.muted }],
		};
	}
	const head = `${id.padEnd(idCols)}  `;
	const room = width - 2 - head.length;
	// Too narrow for a reason beside it, the row gives `how` the room and drops the reason.
	const narrow = room - howCols - 2 < MIN_REASON_COLS;
	const how = narrow
		? cut(item.how, room)
		: cut(item.how, howCols).padEnd(howCols);
	const reason = narrow ? "" : cut(item.reason ?? "", room - how.length - 2);
	const rest = room - how.length - (reason ? reason.length + 2 : 0);
	return {
		keys: [row.key],
		cells: [
			{ text: "○ ", fg: theme.muted },
			{ text: head, fg: theme.defaultFg },
			{ text: how, fg: theme.secondary },
			{
				text: `${reason ? `  ${reason}` : ""}${" ".repeat(Math.max(0, rest))}`,
				fg: theme.muted,
			},
		],
	};
};

/**
 * The map's lines in order, the narrow merge applied: what the view draws, without a renderer.
 * `steps` are the step rows, `left` what follows them.
 */
const mapLines = (
	rows: readonly RunMap.Row[],
	layout: Layout,
): { steps: Line[]; left: Line[] } => {
	const steps: Line[] = [];
	let run: { steps: ActivityStep[]; keys: string[] } | null = null;
	const flush = (): void => {
		if (!run) return;
		const only = run.steps[0];
		if (run.steps.length === 1 && only)
			steps.push(
				itemLine(
					{ type: "step", key: run.keys[0] ?? "", step: only, open: false },
					layout,
				),
			);
		else steps.push(...mergedLines(run.steps, run.keys, layout));
		run = null;
	};
	// The id and `how` columns, as wide as the widest issue's, `how` up to a third of the row.
	const issues = rows.flatMap((row) =>
		row.type === "left" && idOf(row.item) !== "" ? [row.item] : [],
	);
	const idCols = Math.max(0, ...issues.map((item) => idOf(item).length));
	const howCols = Math.min(
		Math.floor(layout.width / 3),
		Math.max(0, ...issues.map((item) => item.how.length)),
	);
	const left: Line[] = [];
	for (const row of rows) {
		if (row.type === "left") {
			left.push(leftLine(row, idCols, howCols, layout));
			continue;
		}
		const mergeable =
			!layout.wide &&
			row.type === "step" &&
			!row.open &&
			row.step.state === "done" &&
			row.key !== layout.cursor;
		if (mergeable) {
			run ??= { steps: [], keys: [] };
			run.steps.push(row.step);
			run.keys.push(row.key);
			continue;
		}
		flush();
		steps.push(itemLine(row, layout));
	}
	flush();
	return { steps, left };
};

const nameColsOf = (rows: readonly RunMap.Row[], width: number): number =>
	Math.min(
		Math.max(
			8,
			...rows.flatMap((row) =>
				row.type === "step"
					? [row.step.name.length]
					: row.type === "session"
						? [row.session.name.length + SESSION_INDENT]
						: [],
			),
		),
		Math.max(10, Math.floor(width * NAME_SHARE)),
	);

// What the map draws, in order: its lines, and before the left-for-you lines a blank row and their
// heading.
type Entry =
	| { kind: "line"; line: Line }
	| { kind: "gap" }
	| { kind: "heading" };

const entryKey = (entry: Entry): string =>
	entry.kind === "line" ? entry.line.keys.join("\n") : entry.kind;

// The entries a window of `max` rows keeps around the cursor, with how many it left out each side:
// the steps and what was left share it, so a long list of findings never puts the cursor below the
// screen.
const windowed = (
	entries: readonly Entry[],
	cursor: string | undefined,
	max: number,
): { shown: readonly Entry[]; above: number; below: number } => {
	if (max <= 0) return { shown: [], above: 0, below: 0 };
	if (entries.length <= max) return { shown: entries, above: 0, below: 0 };
	const at = Math.max(
		0,
		entries.findIndex(
			(entry) =>
				entry.kind === "line" && entry.line.keys.includes(cursor ?? ""),
		),
	);
	const room = max >= 3 ? max - 2 : max;
	const start = Math.max(
		0,
		Math.min(entries.length - room, at - Math.floor(room / 2)),
	);
	return {
		shown: entries.slice(start, start + room),
		above: max >= 3 ? start : 0,
		below: max >= 3 ? entries.length - start - room : 0,
	};
};

const MapLine = ({
	line,
	selected,
	theme,
	onRow,
}: {
	line: Line;
	selected: boolean;
	theme: Theme.Tokens;
	onRow?: (key: string) => void;
}): ReactNode => {
	const bg = selected ? theme.surface.selected : undefined;
	return (
		<text
			bg={bg}
			wrapMode="none"
			onMouseDown={onRow ? () => onRow(line.keys[0] ?? "") : undefined}
			style={{ height: 1, flexShrink: 0 }}
		>
			<span bg={bg} fg={selected ? theme.text : theme.muted}>
				{selected ? " › " : "   "}
			</span>
			{line.cells.map((cell, at) => (
				<span
					// Index keys: a row's cells are positional.
					key={at}
					bg={bg}
					// The terminal's own foreground reads on the unpainted background; on the selected
					// surface the Selection Rule wants it explicit.
					fg={selected && cell.fg === theme.defaultFg ? theme.text : cell.fg}
					attributes={cell.bold ? TextAttributes.BOLD : 0}
				>
					{cell.text}
				</span>
			))}
		</text>
	);
};

const More = ({ count, theme }: { count: number; theme: Theme.Tokens }) =>
	count > 0 ? (
		<text fg={theme.muted} style={{ height: 1, flexShrink: 0 }}>
			{`   … ${count} more`}
		</text>
	) : null;

export const RunMapView = ({
	card,
	view,
	asking,
	width,
	maxRows,
	spinnerFrame,
	onRow,
}: {
	card: RunMap.Card;
	view: RunMap.View;
	asking: ReadonlySet<string>;
	width: number;
	// The rows the steps and what was left may take, the cursor kept in sight within them.
	maxRows: number;
	spinnerFrame: string;
	onRow?: (key: string) => void;
}): ReactNode => {
	const theme = useTheme();
	const rows = RunMap.rows(card, view);
	const cursor = RunMap.cursor(card, view, asking);
	// The gutter's three cells come out of the row, which stops at MAX_COLS so a wide pane keeps
	// each result near its time.
	const inner = Math.max(20, Math.min(width, MAX_COLS) - 3);
	const layout: Layout = {
		width: inner,
		wide: width >= WIDE_COLS,
		nameCols: nameColsOf(rows, inner),
		cursor,
		asking,
		spinnerFrame,
		theme,
	};
	const { steps, left } = mapLines(rows, layout);
	const entries: Entry[] = [
		...steps.map((line): Entry => ({ kind: "line", line })),
		...(left.length > 0
			? [
					{ kind: "gap" } as const,
					{ kind: "heading" } as const,
					...left.map((line): Entry => ({ kind: "line", line })),
				]
			: []),
	];
	// The header, question and footer take their actual height first. Window around the
	// cursor using the rows flex layout leaves after the feed has its minimum.
	const [height, setHeight] = useState(maxRows);
	const { shown, above, below } = windowed(entries, cursor, height);
	const issues = (card.left ?? []).filter(
		(item) => item.taskId !== undefined || item.taskShortId !== undefined,
	).length;
	return (
		<box
			style={{
				flexDirection: "column",
				height: Math.min(entries.length, maxRows),
				flexShrink: 1,
				overflow: "hidden",
			}}
			onSizeChange={function (this: BoxRenderable) {
				setHeight(this.height);
			}}
		>
			<More count={above} theme={theme} />
			{shown.map((entry) =>
				entry.kind === "line" ? (
					<MapLine
						key={entryKey(entry)}
						line={entry.line}
						selected={cursor !== undefined && entry.line.keys.includes(cursor)}
						theme={theme}
						onRow={onRow}
					/>
				) : entry.kind === "gap" ? (
					<text key="gap" style={{ height: 1, flexShrink: 0 }}>
						{" "}
					</text>
				) : (
					<text key="heading" style={{ height: 1, flexShrink: 0 }}>
						<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
							{" left for you"}
						</span>
						{issues > 0 ? <span fg={theme.muted}>{` · ${issues}`}</span> : null}
					</text>
				),
			)}
			<More count={below} theme={theme} />
		</box>
	);
};
