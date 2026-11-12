// The detail view as parts: what a task's records say, each record placed once, but for an entry
// the brief lifts, which shows on the `now` tab and stays on the comments tab, the record.
// Pure: records in, the view's content out, so which record lands where is decided and tested
// without a renderer. The view never reads the agent brief (assembleContext); `y` still copies that.
//
// Pinned above the tabs: the task at a glance, where it sits (its subtasks counted there), and any
// question waiting on a human, a session's or an open decision (BoardDecisions asks those). Then one
// tab each for what is in force now (the checklist, the newest entry of each kind the brief lifts as
// a digest, the decisions already made and the subtasks: what changes while the work runs;
// BoardChecklist draws the checklist's lines), the ask (the description and the curated context:
// written once, read when the issue is picked up), the comments and the agent log. The tabs and the
// log's sources are lists, so another tab or another kind of log entry is one more item, not a
// reshape.
import {
	type AgentActivity,
	answeredQuestion,
	CONTEXT_SECTIONS,
	DEFAULT_ENTRY_KIND,
	isAnswerTo,
	parseQuestionBody,
	TASK_STATE_DISPLAY,
	type Task,
	type TaskContextRef,
	type TaskEntry,
	type WorkRef,
} from "@cabane/core";
import { parseDecisionBody } from "@cabane/questions";
import type { BoardActivity } from "./activity";
import type { BoardData } from "./data";

export namespace DetailModel {
	const TABS = ["now", "description", "comments", "log"] as const;
	export type Tab = (typeof TABS)[number];

	/**
	 * The tab a view whose own tab is not yet decided is on: while its records load, before the view
	 * settles it with openingTab.
	 */
	export const DEFAULT_TAB: Tab = "now";

	/** A question waiting on a human, pinned above the tabs. */
	type OpenQuestion = { id: string; question: string };

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

	/** One tab and what it holds; `fresh` when a change landed on it that the human has not seen. */
	export type TabSummary = {
		tab: Tab;
		count?: number;
		empty: boolean;
		fresh?: boolean;
	};

	/**
	 * One subtask on the `now` tab. `done` carries the `✓`; an open one names its state after
	 * the title; a cancelled one stays listed, faint, because it is part of the plan's record.
	 */
	export type SubtaskLine = {
		id: string;
		shortId: string;
		title: string;
		done: boolean;
		cancelled: boolean;
		state?: string;
	};

	/**
	 * A decision already made, as the brief reads it: `question → answer (who, reasoning)`. Open
	 * ones are asked above the tabs instead, and withdrawn ones are not shown.
	 */
	export type DecisionLine = {
		id: string;
		question: string;
		answer: string;
		by: string;
		reasoning?: string;
	};

	/** One curated input: its kind, its label, and the ref it points at. Identity, never content. */
	export type ContextLine = {
		id: string;
		kind: string;
		label?: string;
		uri: string;
	};

	/**
	 * A kind's newest entry, lifted onto the `now` tab as the brief lifts it: the kind's name and
	 * title, who wrote it and when, the kind's framing line, the body and its sections, and how many
	 * older entries of the kind the comments tab holds.
	 */
	export type LiftedEntry = {
		id: string;
		kind: string;
		title: string;
		framing: string;
		author: string;
		at: string;
		body: string;
		sections: BodySection[];
		earlier: number;
	};

	/**
	 * One part of a lifted body read as markdown: the text before its first heading (no `heading`),
	 * or a heading at the body's top level and everything under it up to the next one, deeper
	 * headings included. `lines` are its source lines without the heading's own and without the
	 * blank ones at either end; `size` counts the ones that are not blank.
	 */
	type BodySection = { heading?: string; lines: string[]; size: number };

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

	// A session question is answered by an activity whose context is `answers <question-id>`.
	const unansweredQuestions = (
		activities: readonly AgentActivity[],
	): AgentActivity[] =>
		activities.filter(
			(a) =>
				a.type === "question" &&
				!activities.some((d) => isAnswerTo(d.context, a.id)),
		);

	// ── pinned ──────────────────────────────────────────────────────────────────────────────────

	/**
	 * What waits on a human: every question a session asked that nothing answers yet, then any the
	 * host reported that the records do not carry (a host that tracks sessions of its own). The one
	 * `pinned` in a banner over the view is left to the banner, so it is not read twice.
	 */
	export const openQuestions = (
		records: BoardData.DetailRecords | undefined,
		awaiting: readonly BoardActivity.AwaitingQuestion[] = [],
		pinned?: string,
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
		return [...fromSessions, ...fromHost].filter((q) => q.id !== pinned);
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
		const { task, links, neighbors, upstream, subtasks } = records;
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
		const children = subtaskSummary(subtasks);
		if (children) lines.push({ key: "subtasks", value: children });
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

	/**
	 * How far the subtasks have got, as the pinned line says it: `3 · 1 done`, a cancelled one
	 * counted apart (`· 1 cancelled`) rather than as work. Absent when there are none.
	 */
	export const subtaskSummary = (
		subtasks: readonly Task[],
	): string | undefined => {
		if (subtasks.length === 0) return undefined;
		const cancelled = subtasks.filter((t) => t.state === "cancelled").length;
		const done = subtasks.filter((t) => t.state === "done").length;
		const parts = [`${subtasks.length - cancelled}`];
		if (done > 0) parts.push(`${done} done`);
		if (cancelled > 0) parts.push(`${cancelled} cancelled`);
		return parts.join(" · ");
	};

	// ── now ─────────────────────────────────────────────────────────────────────────────────────

	/**
	 * One block of the `now` tab, named, so a block can be found again by its name when its records
	 * change (a lifted one by its kind: `lifted:handoff`).
	 */
	export type NowBlock =
		| { name: "checklist" }
		| { name: `lifted:${string}`; entry: LiftedEntry }
		| { name: "decisions"; lines: DecisionLine[] }
		| { name: "subtasks"; lines: SubtaskLine[] };

	/**
	 * What is in force now, in the order it is read: the checklist, the newest entry of each lifted
	 * kind, the decisions made, the subtasks. A block with nothing in it is left out. The checklist's
	 * lines are not here: the board draws them with its own presses (BoardChecklist.shown).
	 */
	export const now = (records: BoardData.DetailRecords): NowBlock[] => {
		const decided = decisions(records);
		const children = subtasks(records);
		return [
			...(records.checklist.length > 0 ? [{ name: "checklist" as const }] : []),
			...lifted(records).map((entry) => ({
				name: `lifted:${entry.kind}` as const,
				entry,
			})),
			...(decided.length > 0
				? [{ name: "decisions" as const, lines: decided }]
				: []),
			...(children.length > 0
				? [{ name: "subtasks" as const, lines: children }]
				: []),
		];
	};

	/** The tab a detail opens on: `now` when anything is in force, otherwise the description. */
	export const openingTab = (records: BoardData.DetailRecords): Tab =>
		now(records).length > 0 ? "now" : "description";

	/**
	 * How long a fresh block's header must stay on screen, with `now` showing, before it counts as
	 * seen. A dwell rather than a key: the human reviews by looking, and a terminal cannot see a
	 * glance, so the mark lasts long enough to be caught from across the desk but goes without a
	 * keypress.
	 */
	export const SEEN_MS = 3000;

	/**
	 * One look at the fresh blocks at `at`: since when each one on screen has been there, and those
	 * whose dwell reached SEEN_MS. Only fresh blocks on screen keep a time, so a block scrolled away,
	 * gone, or no longer fresh starts again from nothing if it comes back.
	 */
	export const dwell = (
		since: ReadonlyMap<BlockName, number>,
		fresh: ReadonlySet<BlockName>,
		onScreen: (name: BlockName) => boolean,
		at: number,
	): { since: Map<BlockName, number>; seen: BlockName[] } => {
		const next = new Map<BlockName, number>();
		const seen: BlockName[] = [];
		for (const name of fresh) {
			if (!onScreen(name)) continue;
			const from = since.get(name) ?? at;
			if (at - from >= SEEN_MS) seen.push(name);
			else next.set(name, from);
		}
		return { since: next, seen };
	};

	/** A block of `now` by its name: `checklist`, `lifted:handoff`. */
	export type BlockName = NowBlock["name"];

	/**
	 * What this board wrote itself between two reads, so a change it caused is not taken for one
	 * that landed: the items it ticked, each with the state it wrote, and the decisions it answered.
	 */
	export type OwnWrites = {
		ticked: ReadonlyMap<string, boolean>;
		answered: ReadonlySet<string>;
	};

	/**
	 * The blocks of `now` whose records changed between two reads of the same task: a lifted kind
	 * whose newest entry is another one, a checklist whose items or ticks moved, decisions made that
	 * gained or lost one, subtasks that came, went, or changed state or title. A change this board made (`own`) is not one,
	 * and a block gone from `after` is never named: there is nothing left to mark.
	 */
	export const changed = (
		before: BoardData.DetailRecords,
		after: BoardData.DetailRecords,
		own: OwnWrites,
	): BlockName[] => {
		const was = new Map(
			before.checklist.map((item) => [item.id, item] as const),
		);
		const ticksMoved =
			before.checklist.length !== after.checklist.length ||
			after.checklist.some((item, index) => {
				const old = was.get(item.id);
				return (
					old === undefined ||
					before.checklist[index]?.id !== item.id ||
					old.text !== item.text ||
					(old.done !== item.done && own.ticked.get(item.id) !== item.done)
				);
			});
		const lastLifted = new Map(
			lifted(before).map((entry) => [entry.kind, entry.id] as const),
		);
		const decided = new Set(decisions(before).map((line) => line.id));
		// A subtask's row as drawn: a rename moves it as a new state does.
		const rows = (records: BoardData.DetailRecords): string =>
			JSON.stringify(subtasks(records));
		return now(after).flatMap((block): BlockName[] => {
			if ("entry" in block)
				return lastLifted.get(block.entry.kind) === block.entry.id
					? []
					: [block.name];
			switch (block.name) {
				case "checklist":
					return ticksMoved ? [block.name] : [];
				case "decisions": {
					const ids = new Set(block.lines.map((line) => line.id));
					const added = block.lines.some(
						(line) => !decided.has(line.id) && !own.answered.has(line.id),
					);
					const gone = [...decided].some((id) => !ids.has(id));
					return added || gone ? [block.name] : [];
				}
				case "subtasks":
					return rows(before) === rows(after) ? [] : [block.name];
			}
		});
	};

	// A fence opens a code block, whose lines are never headings; it closes on a run of the same
	// character at least as long, alone on its line.
	const FENCE = /^ {0,3}(`{3,}|~{3,})/;
	const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

	const closesFence = (line: string, fence: string): boolean => {
		const run = FENCE.exec(line)?.[1];
		return (
			run !== undefined &&
			run[0] === fence[0] &&
			run.length >= fence.length &&
			line.trim() === run
		);
	};

	const isBlank = (line: string): boolean => line.trim() === "";

	const countLines = (lines: readonly string[]): number =>
		lines.filter((line) => !isBlank(line)).length;

	const section = (
		heading: string | undefined,
		lines: string[],
	): BodySection => {
		const first = lines.findIndex((line) => !isBlank(line));
		const last = lines.findLastIndex((line) => !isBlank(line));
		const kept = first < 0 ? [] : lines.slice(first, last + 1);
		return {
			...(heading === undefined ? {} : { heading }),
			lines: kept,
			size: countLines(kept),
		};
	};

	/**
	 * A lifted body read leniently as markdown sections. Headings are read from the text, never
	 * checked against the kind's template: the body's top level is whatever its shallowest ATX
	 * heading is (`##` or `###`), and a `#` line inside a fenced code block is code. Setext headings
	 * (a line underlined with `===`) are read as text. The text before the first heading comes first
	 * when there is any.
	 */
	export const sections = (body: string): BodySection[] => {
		const lines = body.replace(/\r\n?/g, "\n").split("\n");
		const headings: { index: number; level: number; text: string }[] = [];
		let fence: string | undefined;
		lines.forEach((line, index) => {
			if (fence !== undefined) {
				if (closesFence(line, fence)) fence = undefined;
				return;
			}
			fence = FENCE.exec(line)?.[1];
			if (fence !== undefined) return;
			const heading = HEADING.exec(line);
			if (heading?.[1] && heading[2])
				headings.push({ index, level: heading[1].length, text: heading[2] });
		});
		const top = Math.min(...headings.map((h) => h.level));
		const starts = headings.filter((h) => h.level === top);
		const before = section(undefined, lines.slice(0, starts[0]?.index));
		return [
			...(before.size > 0 ? [before] : []),
			...starts.map((h, i) =>
				section(h.text, lines.slice(h.index + 1, starts[i + 1]?.index)),
			),
		];
	};

	/**
	 * Rows a digest's opening may take before the rest is counted instead of shown. Eight at forty
	 * columns is a handoff's summary paragraph, or the first few items of a list, and leaves the
	 * checklist above and the folded headings below on one screen of a 27-row viewport; a wider pane
	 * fits more of the opening in the same rows.
	 */
	const DIGEST_ROWS = 8;

	/**
	 * A lifted body as the `now` tab shows it: the opening rendered (the text before the first
	 * heading, then the first section under its heading; with no headings, the first paragraph),
	 * how many of the opening's lines the cap left out, then each further section as its heading
	 * and its size.
	 */
	type Digest = {
		shown: { heading?: string; text: string }[];
		more: number;
		folded: { heading: string; size: number }[];
	};

	// Rows a line takes wrapped at `width` the way the markdown wraps it, on spaces.
	const wrappedRows = (line: string, width: number): number => {
		if (width <= 0) return 1;
		let rows = 1;
		let column = 0;
		for (const word of line.trim().split(/\s+/)) {
			const needed = column === 0 ? word.length : column + 1 + word.length;
			if (needed <= width) column = needed;
			else if (column === 0) {
				rows += Math.ceil(word.length / width) - 1;
				column = word.length % width || width;
			} else {
				rows += Math.ceil(word.length / width);
				column = word.length % width || width;
			}
		}
		return rows;
	};

	// The words of `line` that fit `rows` rows at `width`, cut with `…`.
	const cutTo = (line: string, rows: number, width: number): string => {
		const words = line.trim().split(/\s+/);
		let kept = "";
		for (const word of words) {
			const next = kept ? `${kept} ${word}` : word;
			if (wrappedRows(`${next} …`, width) > rows) break;
			kept = next;
		}
		return `${kept} …`;
	};

	/**
	 * The digest of a lifted body's sections at `width` columns, its opening held to `rows` rows
	 * (the opening's heading takes one). Rows are estimated by wrapping each source line on spaces;
	 * a line that does not fit is left out whole, unless nothing has been shown yet, when its words
	 * are cut to fit. A cut inside a code fence closes the fence.
	 */
	export const digest = (
		parts: readonly BodySection[],
		width: number,
		rows = DIGEST_ROWS,
	): Digest => {
		const headed = parts.findIndex((p) => p.heading !== undefined);
		const plain = headed < 0 ? parts[0] : undefined;
		const firstBlank = plain?.lines.findIndex(isBlank) ?? -1;
		const opening: { heading?: string; lines: string[] }[] = plain
			? [
					{
						lines:
							firstBlank < 0 ? plain.lines : plain.lines.slice(0, firstBlank),
					},
				]
			: parts.slice(0, headed + 1);
		// With no headings, the lines after the first paragraph are not shown either.
		let more = plain ? plain.size - countLines(opening[0]?.lines ?? []) : 0;
		let budget = rows;
		let full = false;
		let started = false;
		const shown = opening.map((part) => {
			if (part.heading !== undefined) budget -= 1;
			const kept: string[] = [];
			let fence: string | undefined;
			for (const line of part.lines) {
				const cost = isBlank(line) ? 1 : wrappedRows(line, width);
				if (!full && cost <= budget) {
					kept.push(line);
					budget -= cost;
					started ||= !isBlank(line);
					fence =
						fence === undefined
							? FENCE.exec(line)?.[1]
							: closesFence(line, fence)
								? undefined
								: fence;
					continue;
				}
				if (!full && !started && !isBlank(line)) {
					kept.push(cutTo(line, Math.max(1, budget), width));
					started = true;
				} else if (!isBlank(line)) more += 1;
				full = true;
			}
			while (kept.length > 0 && isBlank(kept.at(-1) ?? "")) kept.pop();
			if (fence !== undefined) kept.push(fence);
			return {
				...(part.heading === undefined ? {} : { heading: part.heading }),
				text: kept.join("\n"),
			};
		});
		return {
			shown,
			more,
			folded: plain
				? []
				: parts
						.slice(headed + 1)
						.map((p) => ({ heading: p.heading ?? "", size: p.size })),
		};
	};

	/** The subtasks, in the order they were filed. */
	export const subtasks = (records: BoardData.DetailRecords): SubtaskLine[] =>
		records.subtasks.map((t) => {
			const done = t.state === "done";
			const cancelled = t.state === "cancelled";
			return {
				id: t.id,
				shortId: t.shortId ?? t.id.slice(0, 8),
				title: t.title,
				done,
				cancelled,
				state: cancelled
					? "cancelled"
					: done
						? undefined
						: TASK_STATE_DISPLAY[t.state].label.toLowerCase(),
			};
		});

	/**
	 * For each declared kind projected as `latest`, its newest entry on the task, in the brief's
	 * order: by the core section the kind anchors to, then as the modules declare them. A kind with
	 * no entry on the task lifts nothing.
	 */
	export const lifted = (records: BoardData.DetailRecords): LiftedEntry[] =>
		records.kinds
			.flatMap((kind) =>
				kind.projection === "discussion"
					? []
					: [{ kind, latest: kind.projection.latest }],
			)
			.sort(
				(a, b) =>
					CONTEXT_SECTIONS.indexOf(a.latest.after) -
					CONTEXT_SECTIONS.indexOf(b.latest.after),
			)
			.flatMap(({ kind, latest }) => {
				const ofKind = records.entries.filter((e) => e.kind === kind.name);
				const newest = ofKind.at(-1);
				return newest
					? [
							{
								id: newest.id,
								kind: kind.name,
								title: kind.title,
								framing: latest.framing,
								author: actorName(newest.author),
								at: newest.createdAt,
								body: newest.content.trim(),
								sections: sections(newest.content.trim()),
								earlier: ofKind.length - 1,
							},
						]
					: [];
			});

	/** The decisions made on the task, in the order they were asked. */
	const decisions = (records: BoardData.DetailRecords): DecisionLine[] =>
		records.questions
			.filter((q) => q.status === "answered")
			.map((q) => ({
				id: q.id,
				question: parseDecisionBody(q.body).question,
				answer: q.answer ?? "",
				by: actorName(q.answeredBy ?? "unknown"),
				reasoning: q.reasoning?.trim() || undefined,
			}));

	// ── description ─────────────────────────────────────────────────────────────────────────────

	/** The curated context, in the order it was added. */
	export const contextRefs = (
		records: BoardData.DetailRecords,
	): ContextLine[] =>
		records.contextRefs.map((ref: TaskContextRef) => ({
			id: ref.id,
			kind: ref.kind,
			label: ref.label?.trim() || undefined,
			uri: ref.uri,
		}));

	// ── comments ────────────────────────────────────────────────────────────────────────────────

	/**
	 * The whole timeline, newest first: plain comments and every typed entry, lifted kinds included,
	 * since the tab is the record. Of two in one millisecond the higher id is the newer, as core's
	 * `latestEntry` and the lifted block read them.
	 */
	export const timeline = (records: BoardData.DetailRecords): TaskEntry[] =>
		[...records.entries].sort(
			(a, b) =>
				byAtDescending(a.createdAt, b.createdAt) || byAtDescending(a.id, b.id),
		);

	/**
	 * The word an entry's band carries beside its author: its kind, declared by a module or not.
	 * None for a plain comment, whose band reads as it always has.
	 */
	export const kindLabel = (entry: TaskEntry): string | undefined =>
		entry.kind === DEFAULT_ENTRY_KIND ? undefined : entry.kind;

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

	// What one activity says on its line. An answer reads as its question, then the choice, then who
	// made it when that is on record: `Plain text or markdown? → Plain text · ada`.
	const activityText = (
		a: AgentActivity,
		activities: readonly AgentActivity[],
	): string => {
		if (a.type === "question") return parseQuestionBody(a.body).question;
		const question = answeredQuestion(a.context, activities);
		if (!question) return firstLine(a.body);
		const by = a.author ? ` · ${actorName(a.author)}` : "";
		return `${parseQuestionBody(question.body).question} → ${firstLine(a.body)}${by}`;
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
				text: activityText(a, activities),
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
	 * Each tab and what it holds. `now` and the description have no count (each is one read, there
	 * or not); a tab with nothing in it is `empty`. `liveCards` counts the host's in-flight cards,
	 * which head the log. `freshNow` marks `now` for a change on it not seen yet.
	 */
	export const tabs = (
		records: BoardData.DetailRecords | undefined,
		liveCards = 0,
		freshNow = false,
	): TabSummary[] => {
		const said = records ? records.entries.length : 0;
		const logged = (records ? log(records).length : 0) + liveCards;
		const inForce = records ? now(records).length > 0 : false;
		const described =
			Boolean(records?.task.description?.trim()) ||
			(records?.contextRefs.length ?? 0) > 0;
		return [
			{ tab: "now", empty: !inForce, ...(freshNow ? { fresh: true } : {}) },
			{ tab: "description", empty: !described },
			{ tab: "comments", count: said, empty: said === 0 },
			{ tab: "log", count: logged, empty: logged === 0 },
		];
	};

	// Label sets, longest first: the bar takes the first that fits its room whole, so a label is
	// shortened before anything is cut.
	const LABELS: readonly Record<Tab, string>[] = [
		{
			now: "now",
			description: "description",
			comments: "comments",
			log: "log",
		},
		{ now: "now", description: "about", comments: "comments", log: "log" },
	];

	type TabCell = { tab: Tab; text: string; fresh: boolean };

	/** What a fresh tab's text carries in front of it: the fresh-change glyph of a strip's `✦ ai`. */
	export const FRESH_MARK = "✦ ";

	/** The bar: each tab's text and the padding either side of it. */
	type TabBar = { cells: TabCell[]; pad: number };

	/** Columns the bar takes: each cell padded, or one space between cells when unpadded. */
	export const barWidth = (bar: TabBar): number =>
		bar.cells.reduce(
			(n, cell) =>
				n +
				(cell.fresh ? FRESH_MARK.length : 0) +
				cell.text.length +
				2 * bar.pad,
			0,
		) + (bar.pad === 0 ? Math.max(0, bar.cells.length - 1) : 0);

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
						fresh: t.fresh === true,
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
