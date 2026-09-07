/** @jsxImportSource @opentui/react */
// Activity sidebar: right panel showing host activity cards grouped by kind, then awaiting-input
// questions. Flat panel (no nested borders), frameless rows, bold section titles — lifted from
// zact-v2 ui-otui's sidebar. Pure rendering; state lives in BoardNav.SidebarState.
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import type { BoardActivity } from "./activity";
import { elapsed } from "./elapsed";
import type { ActivityCard } from "./ports";
import { SPINNER_IDLE } from "./spinner";

const MUTED_COLOR = "#6b7280";
const ACCENT_COLOR = "#f97316";
const SIDEBAR_BG = "#1c1c1c";
const FAILED_COLOR = "#ef4444";
const SELECTED_FG = "#e6edf3";
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
			return card.stale ? SPINNER_IDLE : spinnerFrame;
	}
};

const cardColor = (card: ActivityCard): string => {
	switch (card.status) {
		case "completed":
			return MUTED_COLOR;
		case "failed":
			return FAILED_COLOR;
		case "paused":
			return MUTED_COLOR;
		case "running":
		case "pending":
			return card.stale ? MUTED_COLOR : ACCENT_COLOR;
	}
};

// A single flat row in the sidebar. `focus` is whether the sidebar is focused; `selected`
// is whether THIS row is the active selection.
const SidebarRow = ({
	text,
	fg,
	focused,
	selected,
	available,
}: {
	text: string;
	fg: string;
	focused: boolean;
	selected: boolean;
	available: number;
}): ReactNode => {
	const gutter = focused && selected ? FOCUS_GUTTER : NORMAL_GUTTER;
	const rowFg = selected && focused ? SELECTED_FG : fg;
	const truncated =
		text.length + gutter.length > available
			? `${text.slice(0, Math.max(0, available - gutter.length - 1))}…`
			: text;
	return (
		<text bg={SIDEBAR_BG} fg={rowFg}>
			{gutter}
			{truncated}
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

// The row text for a card: `⠹ impl-tasks · JAKE-9 · 2m14s`, detail lines after the task label.
export const cardRowText = (
	card: ActivityCard,
	spinnerFrame: string,
	resolveShortId: TaskResolver,
): string => {
	const shortId =
		card.taskShortId ??
		(card.taskId ? (resolveShortId(card.taskId) ?? "—") : "—");
	const parts = [`${cardGlyph(card, spinnerFrame)} ${card.label}`, shortId];
	if (card.detail.length > 0) parts.push(...card.detail);
	else parts.push(elapsed(card.startedAt, card.finishedAt));
	return parts.join(" · ");
};

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
}): ReactNode => (
	<>
		{spaced ? (
			<text key={`${id}-spacer`} bg={SIDEBAR_BG}>
				{" "}
			</text>
		) : null}
		<text
			key={`${id}-title`}
			bg={SIDEBAR_BG}
			fg={MUTED_COLOR}
			attributes={TextAttributes.BOLD}
		>
			{title}
		</text>
	</>
);

export const Sidebar = ({
	activity,
	sidebarWidth,
	focused,
	selectedIndex,
	spinnerFrame,
	resolveShortId,
}: SidebarProps): ReactNode => {
	const items = buildSidebarItems(activity);
	const available = sidebarWidth - 1; // -1 for border

	if (items.length === 0) {
		return (
			<box
				style={{
					width: sidebarWidth,
					flexDirection: "column",
					backgroundColor: SIDEBAR_BG,
					paddingLeft: 1,
				}}
			>
				<text bg={SIDEBAR_BG} fg={MUTED_COLOR}>
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
					text={cardRowText(card, spinnerFrame, resolveShortId)}
					fg={cardColor(card)}
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
					text={`? ${shortId} · ${firstLine}`}
					fg={ACCENT_COLOR}
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
				backgroundColor: SIDEBAR_BG,
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
