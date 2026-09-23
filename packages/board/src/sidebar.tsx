/** @jsxImportSource @opentui/react */
// Activity sidebar: right panel showing host activity cards grouped by kind, then awaiting-input
// questions. Flat panel (no nested borders), frameless rows, bold section titles — lifted from
// zact-v2 ui-otui's sidebar. Pure rendering; state lives in BoardNav.SidebarState.
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { BoardActivity } from "./activity";
import { CopilotLog } from "./copilot-log";
import { elapsed } from "./elapsed";
import type { ActivityCard } from "./ports";
import { RUNNING_ECHO, SPINNER_IDLE } from "./spinner";
import { type Theme, useTheme } from "./theme";

const FOCUS_GUTTER = "> ";
const NORMAL_GUTTER = "  ";

// Status glyph per zact-v2 StatusGlyph: `•` green completed, `✗` red failed, ⏸ paused; running and
// pending take the spinner frame (or the idle glyph when the host marked the card stale).
const cardGlyph = (card: ActivityCard, spinnerFrame: string): string => {
	switch (card.status) {
		case "completed":
			return "•";
		case "failed":
			return "✗";
		case "paused":
			return "⏸";
		case "running":
		case "pending":
			// A stale card has nothing to animate, and the copilot's row is an echo: its pane is on
			// screen in every view and animates the same turn. Both still SAY running, without motion.
			if (card.stale) return SPINNER_IDLE;
			// The copilot's pane is on screen in every view and animates this same turn.
			return card.kind === CopilotLog.KIND ? RUNNING_ECHO : spinnerFrame;
	}
};

// DESIGN.md's glyph table: the glyph carries the state's hue. Running work is the working hue, never
// the accent — nothing about it is waiting on the human — and a stale runner drops to muted.
const glyphColor = (card: ActivityCard, theme: Theme.Tokens): string => {
	switch (card.status) {
		case "completed":
			return theme.done;
		case "failed":
			return theme.failed;
		case "paused":
			return theme.muted;
		case "running":
		case "pending":
			return card.stale ? theme.muted : theme.working;
	}
};

// The row's words after the glyph: live work reads in the panel's foreground, settled work is meta.
const textColor = (card: ActivityCard, theme: Theme.Tokens): string => {
	switch (card.status) {
		case "failed":
			return theme.failed;
		case "running":
		case "pending":
			return card.stale ? theme.muted : theme.text;
		case "completed":
		case "paused":
			return theme.muted;
	}
};

// A single flat row in the sidebar. `focus` is whether the sidebar is focused; `selected`
// is whether THIS row is the active selection. The glyph keeps its hue; a focused selection paints
// the selected surface with an explicit fg on every cell (the Selection Rule).
const SidebarRow = ({
	glyph,
	glyphFg,
	text,
	fg,
	focused,
	selected,
	available,
}: {
	glyph: string;
	glyphFg: string;
	text: string;
	fg: string;
	focused: boolean;
	selected: boolean;
	available: number;
}): ReactNode => {
	const theme = useTheme();
	const active = focused && selected;
	const gutter = active ? FOCUS_GUTTER : NORMAL_GUTTER;
	const bg = active ? theme.surface.selected : theme.surface.raised;
	const line = `${glyph} ${text}`;
	const room = Math.max(0, available - gutter.length);
	const shown =
		line.length > room ? `${line.slice(0, Math.max(0, room - 1))}…` : line;
	return (
		<text bg={bg} fg={active ? theme.text : fg}>
			{gutter}
			<span fg={glyphFg}>{shown.slice(0, glyph.length)}</span>
			{shown.slice(glyph.length)}
		</text>
	);
};

// Resolve a task ULID to its shortId from the board's loaded sections.
type TaskResolver = (taskId: string) => string | undefined;

// Build the flat item list the sidebar renders. Each item carries a type so `enter` routes
// correctly (card → event view or task detail, input → task detail). Cards keep the source's
// order within a kind; kinds appear in first-seen order.
export type SidebarItem =
	| { type: "card"; card: ActivityCard }
	| { type: "input"; question: BoardActivity.AwaitingQuestion };

// Cards grouped by kind, first-seen order preserved. Exported pure for tests.
export const groupCards = (
	cards: ActivityCard[],
): { kind: string; cards: ActivityCard[] }[] => {
	const groups = new Map<string, ActivityCard[]>();
	for (const card of cards) {
		const list = groups.get(card.kind) ?? [];
		list.push(card);
		groups.set(card.kind, list);
	}
	return [...groups].map(([kind, list]) => ({ kind, cards: list }));
};

export const buildSidebarItems = (
	activity: BoardActivity.ActivityMap,
): SidebarItem[] => {
	const items: SidebarItem[] = [];
	for (const group of groupCards(activity.cards)) {
		for (const card of group.cards) items.push({ type: "card", card });
	}
	for (const questions of activity.questionsByTaskId.values()) {
		for (const q of questions) {
			items.push({ type: "input", question: q });
		}
	}
	return items;
};

// The words after a card's glyph: `impl-tasks · JAKE-9 · 2m14s`, detail lines after the task label.
const cardWords = (
	card: ActivityCard,
	resolveShortId: TaskResolver,
): string => {
	const shortId =
		card.taskShortId ??
		(card.taskId ? (resolveShortId(card.taskId) ?? "—") : "—");
	const parts = [card.label, shortId];
	if (card.detail.length > 0) parts.push(...card.detail);
	else parts.push(elapsed(card.startedAt, card.finishedAt));
	return parts.join(" · ");
};

// The row text for a card: `⠹ impl-tasks · JAKE-9 · 2m14s`, detail lines after the task label.
export const cardRowText = (
	card: ActivityCard,
	spinnerFrame: string,
	resolveShortId: TaskResolver,
): string =>
	`${cardGlyph(card, spinnerFrame)} ${cardWords(card, resolveShortId)}`;

export type SidebarProps = {
	activity: BoardActivity.ActivityMap;
	sidebarWidth: number;
	focused: boolean;
	selectedIndex: number;
	spinnerFrame: string;
	resolveShortId: TaskResolver;
};

const SectionTitle = ({
	id,
	title,
	spaced,
}: {
	id: string;
	title: string;
	spaced: boolean;
}): ReactNode => {
	const theme = useTheme();
	return (
		<>
			{spaced ? (
				<text key={`${id}-spacer`} bg={theme.surface.raised}>
					{" "}
				</text>
			) : null}
			<text
				key={`${id}-title`}
				bg={theme.surface.raised}
				fg={theme.text}
				attributes={TextAttributes.BOLD}
			>
				{title}
			</text>
		</>
	);
};

export const Sidebar = ({
	activity,
	sidebarWidth,
	focused,
	selectedIndex,
	spinnerFrame,
	resolveShortId,
}: SidebarProps): ReactNode => {
	const theme = useTheme();
	// The panel sits on the raised surface, one step up from the terminal's own background.
	const panelBg = theme.surface.raised;
	const items = buildSidebarItems(activity);
	const available = sidebarWidth - 1; // -1 for border

	if (items.length === 0) {
		return (
			<box
				style={{
					width: sidebarWidth,
					flexDirection: "column",
					backgroundColor: panelBg,
					paddingLeft: 1,
				}}
			>
				<text bg={panelBg} fg={theme.muted}>
					no activity
				</text>
			</box>
		);
	}

	// Flat render list: one title per kind group, then the input section. Row indexes advance in
	// lockstep with buildSidebarItems so `selectedIndex` addresses the same item the reducer moved to.
	let globalIdx = 0;
	const sections: ReactNode[] = [];

	for (const group of groupCards(activity.cards)) {
		sections.push(
			<SectionTitle
				key={`kind-${group.kind}`}
				id={`kind-${group.kind}`}
				title={group.kind}
				spaced={sections.length > 0}
			/>,
		);
		for (const card of group.cards) {
			sections.push(
				<SidebarRow
					key={`card-${card.id}`}
					glyph={cardGlyph(card, spinnerFrame)}
					glyphFg={glyphColor(card, theme)}
					text={cardWords(card, resolveShortId)}
					fg={textColor(card, theme)}
					focused={focused}
					selected={globalIdx === selectedIndex}
					available={available}
				/>,
			);
			globalIdx++;
		}
	}

	const inputItems = items.filter((i) => i.type === "input");
	if (inputItems.length > 0) {
		sections.push(
			<SectionTitle
				key="input"
				id="input"
				title="input needed"
				spaced={sections.length > 0}
			/>,
		);
		for (const item of inputItems) {
			if (item.type !== "input") continue;
			const { question } = item;
			const shortId =
				resolveShortId(question.taskId) ?? question.taskId.slice(0, 8);
			const firstLine = question.question.split("\n")[0] ?? "";
			sections.push(
				<SidebarRow
					key={`input-${question.questionActivityId}`}
					glyph="?"
					glyphFg={theme.accent}
					text={`${shortId} · ${firstLine}`}
					fg={theme.text}
					focused={focused}
					selected={globalIdx === selectedIndex}
					available={available}
				/>,
			);
			globalIdx++;
		}
	}

	return (
		<box
			style={{
				width: sidebarWidth,
				flexDirection: "column",
				backgroundColor: panelBg,
				paddingLeft: 1,
			}}
		>
			<scrollbox style={{ flexGrow: 1 }}>{sections}</scrollbox>
		</box>
	);
};

// Compute the responsive sidebar width: clamp(floor(cols*0.25), 28, 44).
export const sidebarWidth = (cols: number): number =>
	Math.max(28, Math.min(44, Math.floor(cols * 0.25)));

// Minimum terminal width for the sidebar to be shown.
export const MIN_SIDEBAR_COLS = 110;
