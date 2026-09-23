// The detail view as parts: what a task's records say, each record placed once. Pure: records in,
// the view's content out, so which record lands where is decided and tested without a renderer. The
// view never reads the agent brief (assembleContext); `y` still copies that.
//
// Pinned above the tabs: the task at a glance, where it sits, and any question waiting on a human.
// Then one tab each for the description, the comments and the agent log. The tabs and the log's
// sources are lists, so another tab or another kind of log entry is one more item, not a reshape.
import {
	type AgentActivity,
	isAnswerTo,
	parseQuestionBody,
	TASK_STATE_DISPLAY,
	type Task,
	type TaskComment,
	type WorkRef,
} from "@cabane/core";
import type { BoardActivity } from "./activity";
import type { BoardData } from "./data";

export namespace DetailModel {
	export const TABS = ["description", "comments", "log"] as const;
	export type Tab = (typeof TABS)[number];

	export const DEFAULT_TAB: Tab = "description";

	/** A question waiting on a human, pinned above the tabs. */
	export type OpenQuestion = { id: string; question: string };

	/** One compact line of the agent log. `failed` puts it in the failed hue. */
	export type LogLine = {
		id: string;
		glyph: string;
		kind: string;
		text: string;
		at: string;
		failed: boolean;
	};

	/** One pinned fact under the title: `parent JCAB-1 PRD: Cabane`. */
	export type MetaLine = { key: string; value: string };

	/** One part of the summary line; `request` parts take the accent (they wait on a human). */
	export type SummaryPart = { text: string; request: boolean };

	export type TabSummary = { tab: Tab; count?: number; empty: boolean };

	/** A comment author as a name: `cabane://actor/agent/claude` → `claude`. */
	export const actorName = (author: string): string =>
		author.startsWith("cabane://actor/")
			? (author.split("/").at(-1) ?? author)
			: author;

	const firstLine = (text: string): string =>
		text.trim().split("\n")[0]?.trim() ?? "";

	const byAtDescending = (a: string, b: string): number =>
		a < b ? 1 : a > b ? -1 : 0;

	const activitiesOf = (records: BoardData.DetailRecords): AgentActivity[] =>
		records.sessions.flatMap((s) => s.activities);

	// A session question is answered by a decision whose context is `answers <question-id>`.
	const unansweredQuestions = (
		activities: readonly AgentActivity[],
	): AgentActivity[] => {
		const decisions = activities.filter((a) => a.type === "decision");
		return activities.filter(
			(a) =>
				a.type === "question" &&
				!decisions.some((d) => isAnswerTo(d.context, a.id)),
		);
	};

	// ── pinned ──────────────────────────────────────────────────────────────────────────────────

	/**
	 * What waits on a human: every question a session asked that nothing answers yet, then any the
	 * host reported that the records do not carry (a host that tracks sessions of its own).
	 */
	export const openQuestions = (
		records: BoardData.DetailRecords | undefined,
		awaiting: readonly BoardActivity.AwaitingQuestion[] = [],
	): OpenQuestion[] => {
		const fromSessions = records
			? unansweredQuestions(activitiesOf(records)).map((a) => ({
					id: a.id,
					question: parseQuestionBody(a.body).question,
				}))
			: [];
		const seen = new Set(fromSessions.map((q) => q.id));
		const fromHost = awaiting
			.filter((q) => !seen.has(q.questionActivityId))
			.map((q) => ({ id: q.questionActivityId, question: q.question }));
		return [...fromSessions, ...fromHost];
	};

	/** The task at a glance: state, a priority other than normal, kind, assignee, review. */
	export const summary = (task: Task): SummaryPart[] => {
		const parts: SummaryPart[] = [
			{
				text: TASK_STATE_DISPLAY[task.state].label.toLowerCase(),
				request: false,
			},
		];
		if (task.priority !== "normal")
			parts.push({ text: task.priority, request: false });
		parts.push({ text: task.kind, request: false });
		if (task.assignee)
			parts.push({ text: `@${task.assignee}`, request: false });
		if (task.needsReview) parts.push({ text: "needs review", request: true });
		return parts;
	};

	/**
	 * Where the task sits: its parent, what blocks it (with the blocker's state, the thing a glance
	 * wants to know), what it blocks, and the external issue it points at. The link semantics mirror
	 * the agent brief's Position section: `blocks` reads source → target, and `blocked_by` and
	 * `follows` read target → source.
	 */
	export const position = (records: BoardData.DetailRecords): MetaLine[] => {
		const { task, links, neighbors, upstream } = records;
		const byId = new Map(neighbors.map((t) => [t.id, t]));
		const shortIdOf = (id: string): string =>
			byId.get(id)?.shortId ?? id.slice(0, 8);
		const name = (id: string): string => {
			const t = byId.get(id);
			return t ? `${shortIdOf(id)} ${t.title}` : shortIdOf(id);
		};
		const blockerName = (id: string): string => {
			const t = byId.get(id);
			if (!t) return shortIdOf(id);
			const state = TASK_STATE_DISPLAY[t.state].label.toLowerCase();
			return `${shortIdOf(id)} ${state} · ${t.title}`;
		};
		const blockers = new Set<string>();
		const blocks = new Set<string>();
		for (const link of links) {
			const outgoing = link.sourceId === task.id;
			const other = outgoing ? link.targetId : link.sourceId;
			if (link.type === "blocks") (outgoing ? blocks : blockers).add(other);
			if (link.type === "blocked_by" || link.type === "follows")
				(outgoing ? blockers : blocks).add(other);
		}
		const lines: MetaLine[] = [];
		if (task.parentTaskId)
			lines.push({ key: "parent", value: name(task.parentTaskId) });
		for (const id of blockers)
			lines.push({ key: "blocked by", value: blockerName(id) });
		for (const id of blocks) lines.push({ key: "blocks", value: name(id) });
		for (const link of upstream)
			lines.push({
				key: link.provider,
				value: `${link.identifier ?? link.externalId} ${link.title}`,
			});
		return lines;
	};

	// ── comments ────────────────────────────────────────────────────────────────────────────────

	/** Every comment, newest first. */
	export const comments = (records: BoardData.DetailRecords): TaskComment[] =>
		[...records.comments].sort((a, b) =>
			byAtDescending(a.createdAt, b.createdAt),
		);

	// ── log ─────────────────────────────────────────────────────────────────────────────────────

	// Glyphs from DESIGN.md's notation: `✗` failed, `✓` a check, `▶` a step taken, `•` work that
	// landed, `·` everything else said along the way.
	const activityGlyph = (type: string): string => {
		switch (type) {
			case "error":
				return "✗";
			case "verification":
				return "✓";
			case "action":
				return "▶";
			default:
				return "·";
		}
	};

	/** A work ref as a person reads it: `commit:6f2a9c1d…` → `commit 6f2a9c1`. */
	export const refLabel = (ref: WorkRef): string => {
		if (ref.label) return ref.label;
		const colon = ref.uri.indexOf(":");
		if (colon < 0) return ref.uri;
		const scheme = ref.uri.slice(0, colon);
		const value = ref.uri.slice(colon + 1);
		switch (scheme) {
			case "commit":
				return `commit ${value.slice(0, 7)}`;
			case "session":
				return `session ${value.slice(0, 8)}`;
			case "url":
				return value.replace(/^https?:\/\//, "");
			default:
				return `${scheme} ${value}`;
		}
	};

	// Everything a session recorded, except a question still waiting: that one is pinned on top.
	const activityLines = (records: BoardData.DetailRecords): LogLine[] => {
		const activities = activitiesOf(records);
		const pinned = new Set(unansweredQuestions(activities).map((a) => a.id));
		return activities
			.filter((a) => !pinned.has(a.id))
			.map((a) => ({
				id: a.id,
				glyph: activityGlyph(a.type),
				kind: a.severity ? `${a.type} ${a.severity}` : a.type,
				text:
					a.type === "question"
						? parseQuestionBody(a.body).question
						: firstLine(a.body),
				at: a.createdAt,
				failed: a.type === "error",
			}));
	};

	const workLogLines = (records: BoardData.DetailRecords): LogLine[] =>
		records.workLogs.map((w) => ({
			id: w.id,
			glyph: "•",
			kind: "",
			text: [...w.refs.map(refLabel), w.note?.trim()]
				.filter((part): part is string => Boolean(part))
				.join(" · "),
			at: w.createdAt,
			failed: false,
		}));

	/** Where log lines come from. Another kind of entry is one more source here. */
	export type LogSource = (records: BoardData.DetailRecords) => LogLine[];

	export const LOG_SOURCES: readonly LogSource[] = [
		activityLines,
		workLogLines,
	];

	/** The agent log, newest first, from every source. */
	export const log = (
		records: BoardData.DetailRecords,
		sources: readonly LogSource[] = LOG_SOURCES,
	): LogLine[] =>
		sources
			.flatMap((source) => source(records))
			.sort((a, b) => byAtDescending(a.at, b.at));

	// ── tabs ────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Each tab and what it holds. The description has no count (it is one thing, there or not); a
	 * tab with nothing in it is `empty`. `liveCards` counts the host's in-flight cards, which head
	 * the log.
	 */
	export const tabs = (
		records: BoardData.DetailRecords | undefined,
		liveCards = 0,
	): TabSummary[] => {
		const said = records ? records.comments.length : 0;
		const logged = (records ? log(records).length : 0) + liveCards;
		return [
			{ tab: "description", empty: !records?.task.description?.trim() },
			{ tab: "comments", count: said, empty: said === 0 },
			{ tab: "log", count: logged, empty: logged === 0 },
		];
	};

	// Label sets, longest first: the bar takes the first that fits its room whole, so a label is
	// shortened before anything is cut.
	const LABELS: readonly Record<Tab, string>[] = [
		{ description: "description", comments: "comments", log: "log" },
		{ description: "about", comments: "comments", log: "log" },
	];

	export type TabCell = { tab: Tab; text: string };

	/** The bar: each tab's text and the padding either side of it. */
	export type TabBar = { cells: TabCell[]; pad: number };

	/** Columns the bar takes: each cell padded, or one space between cells when unpadded. */
	export const barWidth = (bar: TabBar): number =>
		bar.cells.reduce((n, cell) => n + cell.text.length + 2 * bar.pad, 0) +
		(bar.pad === 0 ? Math.max(0, bar.cells.length - 1) : 0);

	/** The widest bar that fits `room` columns, else the narrowest there is. */
	export const tabBar = (
		summaries: readonly TabSummary[],
		room: number,
	): TabBar => {
		let narrowest: TabBar = { cells: [], pad: 0 };
		for (const pad of [1, 0]) {
			for (const labels of LABELS) {
				const bar: TabBar = {
					pad,
					cells: summaries.map((t) => ({
						tab: t.tab,
						text:
							t.count === undefined
								? labels[t.tab]
								: `${labels[t.tab]} ${t.count}`,
					})),
				};
				if (barWidth(bar) <= room) return bar;
				narrowest = bar;
			}
		}
		return narrowest;
	};

	/** The tab `delta` steps from `tab`, wrapping at either end. */
	export const stepTab = (tab: Tab, delta: number): Tab => {
		const index = TABS.indexOf(tab);
		const next = (((index + delta) % TABS.length) + TABS.length) % TABS.length;
		return TABS[next] ?? DEFAULT_TAB;
	};

	/** The tab behind digit `n` (1-based), if there is one. */
	export const tabAt = (n: number): Tab | undefined => TABS[n - 1];
}
