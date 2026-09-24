/** @jsxImportSource @opentui/react */
// The grouped-list surface (linear-tui style): a header line + one <scrollbox> holding sections by
// state, each a bold header over one truncated line per task. Subtasks render indented under an
// expanded parent. Pure rendering — it takes sections + selection + expansion and draws them; data
// loading, selection, and expansion state live in App / BoardNav.

import {
	TASK_PRIORITY_DISPLAY,
	TASK_STATE_DISPLAY,
	type Task,
} from "@cabane/core";
import {
	type ColorInput,
	type MouseEvent,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import { BoardActivity } from "./activity";
import type { BoardData } from "./data";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import type { ActivityCard } from "./ports";
import { RUNNING_ECHO, SPINNER_IDLE, useSpinnerFrame } from "./spinner";
import { type Theme, useTheme } from "./theme";

// OpenTUI needs terminal colors; the display configs carry Tailwind class tokens. Map the priority
// tokens the board uses to theme roles, so display.ts stays the single source of which priority gets
// which color and the theme owns the values. The accent also marks the review flag, the mark glyph
// and the copilot's fingerprint below.
const PRIORITY_ROLE: Record<string, (theme: Theme.Tokens) => string> = {
	"text-gray-400": (theme) => theme.secondary,
	"text-gray-500": (theme) => theme.muted,
	"text-red-500": (theme) => theme.failed,
	"text-orange-500": (theme) => theme.accent,
};

const priorityColor = (token: string, theme: Theme.Tokens): string =>
	PRIORITY_ROLE[token]?.(theme) ?? theme.secondary;

// The `m` glyph, with its trailing space; two blanks keep unmarked titles column-aligned with it
// while any visible row is marked (see heldColumns).
const MARK_GLYPH = "● ";
const MARK_BLANK = "  ";
// The copilot's fingerprint on a row it changed this turn. Transient — the keypress that dismisses
// the turn's footer indicator clears it — so unlike the mark it holds no column when absent.
const AI_GLYPH = "✦ ai ";
// This row points at an issue in someone else's tracker. Like the mark it holds its column on the
// rows without one while any visible row has one, so the glyphs line up and one vertical scan
// answers "which of these is team work" — a trailing badge would float at a different offset on
// every row and answer nothing at a glance.
// It is the only thing the row says about the link: WHICH issue is the detail view's job. Single
// narrow BMP codepoint on purpose; `fixed` below counts columns with `.length`, and the font target
// (IBM Plex Mono) has no Nerd Font private-use range to draw a real provider logo from.
const LINK_GLYPH = "◆ ";
const LINK_BLANK = "  ";
// Never let the title column collapse to nothing on a very narrow frame.
const MIN_TITLE_WIDTH = 4;
// Columns held back from the terminal width for the scrollbar + a safety margin, so a full row never
// wraps into a second line (the small-screen fix is truncation, never wrapping).
const RESERVED_COLS = 2;

// Selection = the selected surface + an explicit fg on every cell. NEVER TextAttributes.INVERSE:
// with unset colors inverse swaps undefined/default and renders white-on-white in a real terminal
// (JJAK-1017). The tree caret (`▸`/`▾`) is NOT the selection marker — it signals expandability only.
// Per-row selection styling. Pure so nav-less tests can assert the invariant that a selected row ALWAYS
// pairs an explicit bg with an explicit fg on every cell and never emits INVERSE. `idFg` keeps the
// priority color when idle (the one content color); selection overrides it for contrast. A row the
// copilot touched this turn steps up to the raised surface — fresh change is contrast, not hue — and
// a painted row needs the explicit fg as much as a selected one does.
export type RowStyle = {
	bg: string | undefined;
	idFg: string;
	titleFg: ColorInput;
	metaFg: string;
	caretFg: string;
};

export const rowStyle = (
	selected: boolean,
	idColor: string,
	theme: Theme.Tokens,
	touched = false,
): RowStyle => {
	if (selected)
		return {
			bg: theme.surface.selected,
			idFg: theme.text,
			titleFg: theme.text,
			metaFg: theme.text,
			caretFg: theme.text,
		};
	return {
		bg: touched ? theme.surface.raised : undefined,
		idFg: idColor,
		titleFg: touched ? theme.text : theme.defaultFg,
		metaFg: theme.muted,
		caretFg: theme.muted,
	};
};

/**
 * Which gutter columns the visible rows hold. A column costs its two cells on every row, so it is
 * held only while at least one visible row puts a glyph in it; a board with nothing marked and
 * nothing linked gives those four columns back to the titles.
 */
export const heldColumns = (
	rows: readonly BoardNav.VisibleRow[],
	marked: ReadonlySet<string>,
	linked: ReadonlySet<string>,
): { mark: boolean; link: boolean } => ({
	mark: rows.some((row) => marked.has(row.task.id)),
	link: rows.some((row) => linked.has(row.task.id)),
});

// Truncate to a single line with a trailing ellipsis — the whole point of the list layout is one row
// per task that never wraps, so titles are cut to fit the frame.
const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

// The ` · `-prefixed badge for a row's first in-flight card: `⠹ loop · implement 3`. Paused shows ⏸
// with no churn; a stale running card (the host's crashed-runner heuristic) keeps the badge but drops
// the animation and dims to muted. Exported pure so the badge text/width contract is assertable
// without a renderer.
export const cardBadge = (
	card: ActivityCard,
	frame: string,
): { text: string; muted: boolean } => {
	if (card.status === "paused")
		return { text: ` · ⏸ ${card.label} · paused`, muted: false };
	const glyph = card.status === "running" && !card.stale ? frame : SPINNER_IDLE;
	const detail = card.detail[0] ?? card.status;
	return {
		text: ` · ${glyph} ${card.label} · ${detail}`,
		muted: card.stale === true,
	};
};

// Extra in-flight cards beyond the first collapse to a count so a busy row never wraps.
export const moreBadge = (count: number, frame: string): string =>
	count > 0 ? ` · ${frame} +${count}` : "";

// The header status strip: ` · ⠹ 2 loops · 1 run · 1 input` when anything is in flight, ""
// otherwise (quiet by default). Cards count under their host-given `kind`, in first-seen order.
export const activityStrip = (
	activity: BoardActivity.ActivityMap,
	frame: string,
): string => {
	const byKind = new Map<string, number>();
	for (const card of activity.cards) {
		if (
			card.status !== "running" &&
			card.status !== "pending" &&
			card.status !== "paused"
		)
			continue;
		byKind.set(card.kind, (byKind.get(card.kind) ?? 0) + 1);
	}
	const inputs = activity.questionsByTaskId.size;
	const parts: string[] = [];
	let first = true;
	for (const [kind, count] of byKind) {
		// Hosts name kinds in the plural ("loops"); one of them reads better singular.
		const noun = count === 1 && kind.endsWith("s") ? kind.slice(0, -1) : kind;
		parts.push(`${first ? `${frame} ` : ""}${count} ${noun}`);
		first = false;
	}
	if (inputs > 0) parts.push(`${inputs} input`);
	return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
};

// Whether the spinner interval should run at all: a live (non-stale) running card animates the
// shared spinner frame.
export const anyActivityRunning = BoardActivity.anyRunning;

// The header part for the filters in force: ` · kind: issue · status: done`, "" unfiltered (quiet by
// default, as the marked count is).
export const headerFilters = (
	kind: BoardNav.KindFilter,
	status: BoardNav.StatusFilter,
): string =>
	[
		kind === "all" ? "" : ` · kind: ${kind}`,
		status === "open" ? "" : ` · status: ${status}`,
	].join("");

// The header part for the working set: ` · 3 marked`, "" when nothing is marked (quiet by default).
export const markedLabel = (count: number): string =>
	count > 0 ? ` · ${count} marked` : "";

// The tree caret for a row: two spaces where there is nothing to expand so ids stay column-aligned.
const caretFor = (row: BoardNav.VisibleRow): string => {
	if (row.depth === 1) return "    ";
	if (!row.hasChildren) return "  ";
	return row.expanded ? "▾ " : "▸ ";
};

// Task id -> shortId over every loaded row, children included. Built once per render from the sections
// the board already holds: `loadBoard` queries all seven states regardless of the `f` filter, so a
// CLOSED parent hidden from the current view is still in here to be named. A parent past the archive
// cap isn't loaded at all, hence the miss path in `rowMeta`.
export const shortIdIndex = (
	sections: BoardData.BoardSection[],
): Map<string, string> => {
	const index = new Map<string, string>();
	const add = (task: Task): void => {
		if (task.shortId) index.set(task.id, task.shortId);
	};
	for (const section of sections) {
		for (const row of section.rows) {
			add(row.task);
			for (const child of row.children) add(child);
		}
	}
	return index;
};

// The muted meta tail. Depth 1 shows the subtask's own state (it may differ from the parent's section).
// Depth 0 shows the kind — plus, when the row still carries a parent id, a parent reference: such a row
// is an ORPHANED subtask, promoted to the top level because nothing rendered it as a child (its parent
// is closed, and closed parents are never subtask roots, or it fell past a limit). Without the
// reference the row is indistinguishable from a genuine root item, which is a thing the board would be
// asserting falsely. Plain `in <id>` over a `↳` glyph: the board already spends `▸`/`▾` on tree state,
// and a second arrow with a different meaning costs more to read than the one word it saves. When the
// parent isn't loaded at all (past the archive cap) there is no id to name, so the row says only what
// is certain — it is a subtask — rather than guessing at why its parent is absent.
const orphanMeta = (task: Task, parentShortId?: string): string => {
	if (!task.parentTaskId) return "";
	return parentShortId ? ` · in ${parentShortId}` : " · subtask";
};

export const rowMeta = (
	row: BoardNav.VisibleRow,
	parentShortId?: string,
): string => {
	const task = row.task;
	if (row.depth === 1)
		return ` · ${TASK_STATE_DISPLAY[task.state].label.toLowerCase()}`;
	// Name the parent when it is loaded; otherwise still mark the row, or the lie stands.
	const parent = orphanMeta(task, parentShortId);
	return ` · ${task.kind}${parent}`;
};

const Row = ({
	row,
	rowIndex,
	selected,
	marked,
	touched,
	linked,
	columns,
	available,
	activity,
	onSelect,
	onToggle,
	parentShortId,
}: {
	row: BoardNav.VisibleRow;
	marked: boolean;
	// The gutter columns every visible row holds this frame (heldColumns).
	columns: { mark: boolean; link: boolean };
	// The copilot changed this row during the turn in hand.
	touched: boolean;
	// shortId of this row's parent, when the parent is loaded. Only ever set for an orphaned subtask.
	parentShortId?: string;
	// Index into the flattened visible-row list — the address mouse handlers dispatch back to the reducer.
	rowIndex: number;
	selected: boolean;
	linked: boolean;
	available: number;
	activity?: BoardActivity.ActivityMap;
	onSelect?: (rowIndex: number) => void;
	onToggle?: (rowIndex: number) => void;
}): ReactNode => {
	const theme = useTheme();
	const task = row.task;
	const style = rowStyle(
		selected,
		priorityColor(TASK_PRIORITY_DISPLAY[task.priority].color, theme),
		theme,
		touched,
	);
	const shortId = task.shortId ?? task.id.slice(0, 8);
	const caret = caretFor(row);
	const meta = rowMeta(row, parentShortId);
	const review = task.needsReview ? " · review" : "";
	// In-flight badges: cards match by task id or shortId, questions by task id.
	const cards = activity
		? BoardActivity.inFlightForTask(activity, task.id, shortId)
		: [];
	// Row badges echo the sidebar, which animates the same cards.
	const badge = cards[0] ? cardBadge(cards[0], RUNNING_ECHO) : null;
	const more = moreBadge(cards.length - 1, RUNNING_ECHO);
	const input = activity?.questionsByTaskId.has(task.id) ? " · ? input" : "";
	const mark = columns.mark ? (marked ? MARK_GLYPH : MARK_BLANK) : "";
	const link = columns.link ? (linked ? LINK_GLYPH : LINK_BLANK) : "";
	const ai = touched ? AI_GLYPH : "";
	// Badge widths count against the title so a badged row still never wraps.
	const fixed =
		caret.length +
		shortId.length +
		2 +
		mark.length +
		link.length +
		ai.length +
		meta.length +
		review.length +
		(badge?.text.length ?? 0) +
		more.length +
		input.length;
	const title = truncate(
		task.title,
		Math.max(MIN_TITLE_WIDTH, available - fixed),
	);

	// Caret click toggles expansion without also selecting/opening — stopPropagation keeps the row box's
	// select handler from firing on the same press.
	const toggle =
		onToggle && row.depth === 0 && row.hasChildren
			? (event: MouseEvent) => {
					event.stopPropagation();
					onToggle(rowIndex);
				}
			: undefined;

	return (
		<box
			id={`row-${task.id}`}
			onMouseDown={onSelect ? () => onSelect(rowIndex) : undefined}
			style={{
				flexDirection: "row",
				flexShrink: 0,
				backgroundColor: style.bg,
			}}
		>
			<text bg={style.bg} fg={style.caretFg} onMouseDown={toggle}>
				{caret}
			</text>
			<text bg={style.bg} fg={style.titleFg}>
				<span fg={style.idFg}>{shortId}</span>
				{"  "}
				<span fg={marked ? theme.accent : style.titleFg}>{mark}</span>
				{/* Chrome, not accent: a linked issue is a fact about the row, not a request for action. */}
				<span fg={theme.muted}>{link}</span>
				{/* Fresh change, not a request: the row's own foreground, on the raised surface. */}
				{ai ? <span fg={style.titleFg}>{ai}</span> : null}
				{title}
				<span fg={style.metaFg}>{meta}</span>
				{task.needsReview ? <span fg={theme.accent}> · review</span> : null}
				{badge ? (
					<span fg={badge.muted ? theme.muted : theme.working}>
						{badge.text}
					</span>
				) : null}
				{more ? <span fg={theme.working}>{more}</span> : null}
				{input ? <span fg={theme.accent}>{input}</span> : null}
			</text>
		</box>
	);
};

const Section = ({
	group,
	selectedId,
	marked,
	touched,
	linked,
	columns,
	firstRowIndex,
	available,
	activity,
	onSelect,
	onToggle,
	parentIds,
}: {
	marked: ReadonlySet<string>;
	touched: ReadonlySet<string>;
	linked: ReadonlySet<string>;
	columns: { mark: boolean; link: boolean };
	// id -> shortId over every loaded task, for naming an orphaned subtask's parent.
	parentIds: Map<string, string>;
	// Pre-flattened rows from BoardNav.visibleSections — the SAME flatten the reducer addresses, so
	// the running row index below matches BoardNav.visibleRows by construction (filter included).
	group: BoardNav.SectionRows;
	selectedId: string | null;
	// Where this section's rows start in BoardNav.visibleRows, so a row's index matches it.
	firstRowIndex: number;
	available: number;
	activity?: BoardActivity.ActivityMap;
	onSelect?: (rowIndex: number) => void;
	onToggle?: (rowIndex: number) => void;
}): ReactNode => {
	const theme = useTheme();
	// The header count is top-level rows only (matches the unfiltered section.rows.length; under a
	// filter it becomes the matched-parent count for that section).
	const topLevel = group.rows.filter((row) => row.depth === 0).length;
	return (
		<box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
			<text>
				<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
					{group.section.label.toLowerCase()}
				</span>
				<span fg={theme.muted}> · {topLevel}</span>
			</text>
			{group.rows.map((row, index) => (
				<Row
					key={row.task.id}
					row={row}
					rowIndex={firstRowIndex + index}
					selected={row.task.id === selectedId}
					marked={marked.has(row.task.id)}
					touched={touched.has(row.task.id)}
					linked={linked.has(row.task.id)}
					columns={columns}
					available={available}
					activity={activity}
					onSelect={onSelect}
					onToggle={onToggle}
					parentShortId={
						row.task.parentTaskId
							? parentIds.get(row.task.parentTaskId)
							: undefined
					}
				/>
			))}
		</box>
	);
};

// Nothing open and nothing filtered: what a new scope shows, and where its first issue comes from.
// The copilot is the pane right under the list, always mounted.
export const EMPTY_HINTS = [
	"ask the copilot below to file one,",
	'or run kabane add "…" in a shell.',
] as const;

// Each section with where its rows start in BoardNav.visibleRows.
const withFirstRowIndex = (
	groups: BoardNav.SectionRows[],
): { group: BoardNav.SectionRows; firstRowIndex: number }[] => {
	let next = 0;
	return groups.map((group) => {
		const firstRowIndex = next;
		next += group.rows.length;
		return { group, firstRowIndex };
	});
};

const EmptyBoard = (): ReactNode => {
	const theme = useTheme();
	return (
		<box style={{ flexDirection: "column" }}>
			<text fg={theme.defaultFg}>nothing open here.</text>
			{EMPTY_HINTS.map((line) => (
				<text key={line} fg={theme.muted}>
					{line}
				</text>
			))}
		</box>
	);
};

const SEARCH_OFF: BoardNav.SearchState = { mode: "off" };
const NO_MARKS: ReadonlySet<string> = new Set<string>();

// The footer, ONE line, by priority: a transient notice always wins > otherwise the live context's
// hints (Keymap.footer), led by the query being typed (normal fg: it is an active input, not chrome)
// or a committed search's summary, the query as it was typed and its match count, kept short so
// `esc clear` still fits beside it at forty columns. Always a StatusBar so the row is reserved
// and backgrounded whatever the variant.
const Footer = ({
	notice,
	search,
	matchCount,
	keys,
}: {
	notice: BoardNav.Notice | null | undefined;
	search: BoardNav.SearchState;
	matchCount: number;
	keys: Keymap.Live;
}): ReactNode => {
	const theme = useTheme();
	if (notice) {
		return (
			<StatusBar
				text={notice.undoable ? `${notice.text} · ⌃z undo` : notice.text}
				fg={notice.tone === "success" ? theme.done : theme.failed}
			/>
		);
	}
	const hints = Keymap.footer(keys.context, keys.situation);
	if (keys.context === "search" && search.mode === "typing")
		return <StatusBar lead={`/${search.query}▌`} hints={hints} />;
	if (keys.context === "searchResults" && search.mode === "committed") {
		const matches = matchCount === 1 ? "1 match" : `${matchCount} matches`;
		return (
			<StatusBar
				lead={`/${search.query} · ${matches}`}
				leadFg={theme.muted}
				hints={hints}
			/>
		);
	}
	return <StatusBar hints={hints} />;
};

// The footer's context when app.tsx does not say (render-only tests): the pane with focus, else the
// board as its search leaves it, with what the board itself knows about the selected row.
const ownKeys = (
	focus: BoardNav.Focus,
	search: BoardNav.SearchState,
	selectedId: string | null,
	linked: ReadonlySet<string>,
): Keymap.Live => ({
	context:
		focus === "copilot"
			? "copilot"
			: search.mode === "typing"
				? "search"
				: search.mode === "committed"
					? "searchResults"
					: "board",
	situation: {
		selection: selectedId !== null,
		linked: selectedId !== null && linked.has(selectedId),
	},
});

export type BoardProps = {
	sections: BoardData.BoardSection[];
	expanded: ReadonlySet<string>;
	selectedId: string | null;
	// The `/` search state; drives both the row filter and the footer. Optional so render-only tests
	// without search keep working.
	search?: BoardNav.SearchState;
	// In-flight activity (host cards + awaiting-input questions), fetched by app.tsx in the same 5s
	// poll as the board data. Optional — absent means nothing in flight (quiet by default).
	activity?: BoardActivity.ActivityMap;
	scopeLabel?: string;
	// The `i` kind filter. Optional for the same reason as `status` below, and defaulted to `all`,
	// which the header leaves unsaid.
	kind?: BoardNav.KindFilter;
	// The `f` status filter. Optional so render-only tests without it keep working, and defaulted to
	// the value that renders the board exactly as it always has.
	status?: BoardNav.StatusFilter;
	// The `m` working set. Optional for the same reason; absent means nothing marked.
	marked?: ReadonlySet<string>;
	// Rows the copilot changed in the turn in hand (BoardNav.copilotTouched), glyphed until the next
	// keypress. Optional for the same reason.
	touched?: ReadonlySet<string>;
	// Tasks that point at an issue in an external tracker, from the same poll as the board data.
	// Optional for the same reason; absent means nothing is linked.
	linked?: ReadonlySet<string>;
	// The list's scrollbox; app.tsx holds the ref so it can scroll the selected row into view.
	scrollRef?: RefObject<ScrollBoxRenderable | null>;
	// Mouse callbacks; absent in the render-only tests. app.tsx routes both through BoardNav.reduceMouse.
	onSelect?: (rowIndex: number) => void;
	onToggle?: (rowIndex: number) => void;
	// Transient footer feedback; when present it replaces the key hints in the footer for ~1.5s.
	notice?: BoardNav.Notice | null;
	// Which pane has the keyboard — the footer hints follow it.
	focus?: BoardNav.Focus;
	// The copilot pane, rendered between the content and the footer. A slot rather than a float: the
	// panel has real height and must push the view up, not cover it.
	pane?: ReactNode;
	// When the sidebar is visible, its width is subtracted from the available row width for
	// truncation — otherwise a badged row wraps into a second line.
	sidebarWidth?: number;
	// Whose keys the footer shows and what is true right now (BoardNav.keyContext / keySituation).
	// Optional so render-only tests fall back to what the board knows itself.
	keys?: Keymap.Live;
};

export const Board = ({
	sections,
	expanded,
	selectedId,
	search = SEARCH_OFF,
	activity,
	scopeLabel,
	kind = "all",
	status = "open",
	marked = NO_MARKS,
	touched = NO_MARKS,
	linked = NO_MARKS,
	scrollRef,
	onSelect,
	onToggle,
	notice,
	focus = "board",
	pane,
	sidebarWidth: sbWidth = 0,
	keys,
}: BoardProps): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	// One shared spinner frame for every badge + the header strip; the interval only runs while a live
	// running loop is visible (the leaked-idle-timer gotcha — see spinner.ts).
	const spinnerFrame = useSpinnerFrame(
		activity ? anyActivityRunning(activity) : false,
	);
	// A count of exactly what the sidebar is listing in full, three columns to the right. It earns
	// its place only when there is no sidebar to read instead.
	const strip =
		activity && sbWidth === 0 ? activityStrip(activity, spinnerFrame) : "";
	const available = Math.max(MIN_TITLE_WIDTH, width - RESERVED_COLS - sbWidth);
	// Quiet by default: `all` kinds and `open` are what the board shows unfiltered, and this header
	// <text> does no truncation (unlike StatusBar), so an always-on filter part would spend a narrow
	// frame's columns saying that nothing is filtered.
	const filters = headerFilters(kind, status);
	const markedPart = markedLabel(marked.size);
	// The SAME flatten the reducer uses for j/k, mouse addressing, and scroll-into-view — filter
	// included — so the running rowIndex below is in lockstep with BoardNav.visibleRows.
	const groups = BoardNav.visibleSections(sections, expanded, search, status);
	const parentIds = shortIdIndex(sections);
	const matchCount = groups.reduce((n, group) => n + group.rows.length, 0);
	// Any filter can empty the list, and an empty scrollbox reads as a broken board — say "no
	// matches" for a status or a kind that found nothing just as for a query that did.
	const filtering =
		BoardNav.activeQuery(search) !== "" || status !== "open" || kind !== "all";
	const columns = heldColumns(
		groups.flatMap((group) => group.rows),
		marked,
		linked,
	);
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text fg={theme.defaultFg}>
				<span attributes={TextAttributes.BOLD}>
					{`kabane · ${scopeLabel ?? "all scopes"}`.toLowerCase()}
				</span>
				{filters ? <span fg={theme.muted}>{filters}</span> : null}
				{markedPart ? <span fg={theme.accent}>{markedPart}</span> : null}
				{strip ? <span fg={theme.muted}>{strip}</span> : null}
			</text>
			<scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }}>
				{groups.length === 0 ? (
					filtering ? (
						<text fg={theme.muted}>no matches</text>
					) : (
						<EmptyBoard />
					)
				) : (
					withFirstRowIndex(groups).map(({ group, firstRowIndex }) => (
						<Section
							key={group.section.state}
							group={group}
							selectedId={selectedId}
							marked={marked}
							touched={touched}
							linked={linked}
							columns={columns}
							firstRowIndex={firstRowIndex}
							available={available}
							activity={activity}
							onSelect={onSelect}
							onToggle={onToggle}
							parentIds={parentIds}
						/>
					))
				)}
			</scrollbox>
			{pane}
			<Footer
				notice={notice}
				search={search}
				matchCount={matchCount}
				keys={keys ?? ownKeys(focus, search, selectedId, linked)}
			/>
		</box>
	);
};
