/**
 * Planner Storage — assembleContext (S3)
 *
 * The tracker owns context assembly. One primitive assembles an issue's full
 * brief — metadata, description, position in the DAG, curated context refs
 * (deref'd), prior work, and discussion — so every consumer (loop, dispatch,
 * ad-hoc agents, dashboard) embeds one string instead of re-crawling.
 *
 * Linear's `promptContext` insight. NOT the war-room chat engine in
 * packages/core/context/assemble.ts — unrelated.
 *
 * Sections are fetched independently (Promise.all + per-source fallback): a
 * failed sub-fetch omits its section, never fails the call. Every empty
 * section is omitted entirely. A bare reminder returns just its description.
 */

import {
	registeredContextSections,
	ContextSectionSchema,
	type ContextSection,
} from "../context-output";
import {
	type LatestKindSection,
	type ModuleContextSection,
	Modules,
} from "../module";
import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import { Runtime } from "../runtime";
import {
	type AgentActivity,
	type AgentSession,
	answeredQuestion,
	type AssembleContextOpts,
	AssembleContextOptsSchema,
	DEFAULT_ENTRY_KIND,
	type ResolvedAssembleContextOpts,
	type Task,
	type TaskComment,
	type TaskEntry,
	type TaskContextRef,
	type TaskLink,
	type TaskWorkLog,
	type UpstreamLink,
	parseQuestionBody,
} from "../schemas";
import { Planner as PlannerComments } from "./comments";
import { Planner as PlannerContextRefs } from "./context-refs";
import { Planner as SelectDurable } from "./select-durable";
import { Planner as PlannerSessions } from "./sessions";
import { Planner as PlannerTaskLinks } from "./task-links";
import { Planner as PlannerTasks } from "./tasks";
import { Planner as PlannerUpstreamLinks } from "./upstream-links";
import { Planner as PlannerWorkLogs } from "./work-logs";

// ── Section helpers (pure, string | null — null omits the section) ──────────

const metadataLine = (task: Task): string => {
	const parts = [`**State:** ${task.state}`, `**Priority:** ${task.priority}`];
	if (task.assignee) parts.push(`**Assignee:** ${task.assignee}`);
	return parts.join(" · ");
};

const descriptionSection = (task: Task): string | null =>
	task.description ? `## Description\n\n${task.description}` : null;

const upstreamSection = (links: UpstreamLink[]): string | null => {
	if (links.length === 0) return null;

	const lines = links.map((link) => {
		const label = link.identifier ?? link.externalId;
		return `- ${link.provider} · ${label} — ${link.title} — ${link.url}`;
	});

	return `## Upstream\n\n${lines.join("\n")}`;
};

/** Render a neighbor task as "SHORTID (state) — title", falling back to id. */
const neighborRef = (id: string, neighbors: Map<string, Task>): string => {
	const t = neighbors.get(id);
	if (!t) return id;
	return `${t.shortId ?? id.slice(0, 8)} (${t.state}) — ${t.title}`;
};

/**
 * This task's dependencies and dependents. Blocking semantics mirror the loop's readiness logic
 * (briefing/dag.ts):
 * - blocks:     source blocks target → target depends on source
 * - blocked_by: source blocked_by target → source depends on target
 * - follows:    source follows target → source depends on target
 */
const positionDependencies = (taskId: string, links: TaskLink[]) => {
	const blockerIds = new Set<string>();
	const blocksIds = new Set<string>();
	for (const link of links) {
		// What this task is blocked by (its dependencies).
		if (link.type === "blocks" && link.targetId === taskId)
			blockerIds.add(link.sourceId);
		if (link.type === "blocked_by" && link.sourceId === taskId)
			blockerIds.add(link.targetId);
		if (link.type === "follows" && link.sourceId === taskId)
			blockerIds.add(link.targetId);
		// What this task blocks (its dependents).
		if (link.type === "blocks" && link.sourceId === taskId)
			blocksIds.add(link.targetId);
		if (link.type === "blocked_by" && link.targetId === taskId)
			blocksIds.add(link.sourceId);
		if (link.type === "follows" && link.targetId === taskId)
			blocksIds.add(link.sourceId);
	}

	return { blockerIds, blocksIds };
};

/** Position: parent · blockers (w/ states) · blocks · subtask states. */
const positionSection = async (
	jakePath: string,
	task: Task,
	links: TaskLink[],
	subtasks: Task[],
	{ includeSubtasks, strict }: { includeSubtasks: boolean; strict: boolean },
): Promise<Result<string | null>> => {
	const { blockerIds, blocksIds } = positionDependencies(task.id, links);

	const neighborIds = new Set<string>([...blockerIds, ...blocksIds]);
	if (task.parentTaskId) neighborIds.add(task.parentTaskId);

	const fetched = await Promise.all(
		[...neighborIds].map(async (id) => ({
			id,
			result: await PlannerTasks.getTask(jakePath, id),
		})),
	);
	const neighbors = new Map<string, Task>();
	for (const { id, result } of fetched) {
		if (!result.ok && strict)
			return err(
				new Error(
					"Cannot read context position neighbors; retry the bounded read.",
				),
			);
		if (result.ok && result.value) neighbors.set(id, result.value);
	}

	const lines: string[] = [];
	if (task.parentTaskId)
		lines.push(`- Parent: ${neighborRef(task.parentTaskId, neighbors)}`);
	if (blockerIds.size > 0)
		lines.push(
			`- Blocked by: ${[...blockerIds].map((id) => neighborRef(id, neighbors)).join("; ")}`,
		);
	if (blocksIds.size > 0)
		lines.push(
			`- Blocks: ${[...blocksIds].map((id) => neighborRef(id, neighbors)).join("; ")}`,
		);

	if (includeSubtasks && subtasks.length > 0) {
		lines.push(`- Subtasks (${subtasks.length}):`);
		for (const s of subtasks) {
			lines.push(
				`  - ${s.shortId ?? s.id.slice(0, 8)} (${s.state}) — ${s.title}`,
			);
		}
	}

	return ok(lines.length === 0 ? null : `## Position\n\n${lines.join("\n")}`);
};

// ── file: dereferencing (memory-safe: .size checked BEFORE .text()) ─────────

/** Strip the `file:` / `file://` scheme, yielding a filesystem path. */
const filePathFromUri = (uri: string): string =>
	uri.replace(/^file:\/\//, "").replace(/^file:/, "");

type DerefResult =
	| { status: "inlined"; content: string; chars: number }
	| { status: "missing" }
	| { status: "pointer" };

/**
 * Inline a `file:` ref, capped at `cap` chars. A missing file → a pointer note;
 * an oversized file is read via a byte slice so a 5MB ref never blows memory.
 */
const derefFile = async (uri: string, cap: number): Promise<DerefResult> => {
	try {
		const path = filePathFromUri(uri);
		const file = Bun.file(path);
		if (!(await file.exists())) return { status: "missing" };

		const size = file.size;
		if (size > cap) {
			// Read only the first `cap` bytes — never load the whole file.
			const head = await file.slice(0, cap).text();
			return {
				status: "inlined",
				content: `${head}\n\n… [truncated: ${size} bytes total, showing first ${cap}]`,
				chars: head.length,
			};
		}

		const text = await file.text();
		return { status: "inlined", content: text, chars: text.length };
	} catch {
		return { status: "pointer" };
	}
};

const contextRefBlock = async (
	ref: TaskContextRef,
	opts: ResolvedAssembleContextOpts,
	totalUsed: number,
	strict: boolean,
): Promise<{ block: string; chars: number }> => {
	const label = ref.label ?? ref.uri;
	const header = `### [${ref.kind}] ${label}`;
	const note = ref.note ? `\n${ref.note}` : "";
	const colon = ref.uri.indexOf(":");
	const scheme = colon === -1 ? "" : ref.uri.slice(0, colon);

	// Deref only `file:` refs, only while budget remains (else downgrade to pointer).
	if (opts.deref && scheme === "file" && totalUsed < opts.totalRefCap) {
		const cap = Math.min(opts.perRefCap, opts.totalRefCap - totalUsed);
		const result = await derefFile(ref.uri, cap);
		if (result.status === "inlined") {
			return {
				block: `${header}\n${ref.uri}${note}\n\n\`\`\`\n${result.content}\n\`\`\``,
				chars: result.chars,
			};
		}
		if (result.status === "missing") {
			return {
				block: `${header}\n_(missing file: ${ref.uri})_${note}`,
				chars: 0,
			};
		}
		if (strict)
			return {
				block: `${header}\n${ref.uri}${note}\n_(file unreadable/unavailable on this host; pointer only)_`,
				chars: 0,
			};
		// Full mode retains its legacy pointer fallback.
	}

	// Pointer: non-file scheme, deref off, total-cap exhausted, or unreadable.
	return { block: `${header}\n${ref.uri}${note}`, chars: 0 };
};

const contextSection = async (
	refs: TaskContextRef[],
	opts: ResolvedAssembleContextOpts,
	strict: boolean,
): Promise<string | null> => {
	if (refs.length === 0) return null;
	const blocks: string[] = [];
	let totalUsed = 0;
	for (const ref of refs) {
		const { block, chars } = await contextRefBlock(
			ref,
			opts,
			totalUsed,
			strict,
		);
		totalUsed += chars;
		blocks.push(block);
	}
	return `## Context\n\n${blocks.join("\n\n")}`;
};

const priorWorkSection = (workLogs: TaskWorkLog[]): string | null => {
	if (workLogs.length === 0) return null;
	const lines = workLogs.map((w) => {
		const refs = w.refs
			.map((r) => (r.label ? `${r.label} (${r.uri})` : r.uri))
			.join(", ");
		const note = w.note ? `${w.note} — ` : "";
		return `- ${note}${refs}`;
	});
	return `## Prior work\n\n${lines.join("\n")}`;
};

/** One rendered Discussion line + its timestamp, for chronological merging. */
type DiscussionEntry = { createdAt: string; line: string };

const byCreatedAtAscEntry = (a: DiscussionEntry, b: DiscussionEntry): number =>
	new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

const commentEntry = (c: TaskComment): DiscussionEntry => ({
	createdAt: c.createdAt,
	line: `**${c.author}** (${c.authorType}, ${c.createdAt}):\n${c.content}`,
});

/** A kind whose newest entry has its own `latest` section, out of the Discussion. */
const liftedKind = (kind: string): boolean => {
	const declared = Modules.kind(kind);
	return declared !== undefined && declared.projection !== "discussion";
};

/**
 * Every entry of a kind other than `comment` that no `latest` section lifts,
 * whoever wrote it: a writer chose a kind to keep it, so it is never dropped.
 * A kind no registered module declares lands here too, labelled the same way.
 */
const typedEntries = (entries: TaskEntry[]): DiscussionEntry[] =>
	entries
		.filter((e) => e.kind !== DEFAULT_ENTRY_KIND && !liftedKind(e.kind))
		.map((e) => ({
			createdAt: e.createdAt,
			line: `**${e.author}** (${e.kind}, ${e.authorType}, ${e.createdAt}):\n${e.content}`,
		}));

/** ALL human comments — the load-bearing steering, never dropped. */
const humanCommentEntries = (comments: TaskComment[]): DiscussionEntry[] =>
	comments.filter((c) => c.authorType === "human").map(commentEntry);

/** Session-less heuristic: the last 3 AI comments approximate durable signal. */
const lastAiCommentEntries = (comments: TaskComment[]): DiscussionEntry[] =>
	comments
		.filter((c) => c.authorType === "ai")
		.slice(-3)
		.map(commentEntry);

/**
 * One durable activity as a Discussion entry. A decision that answers a
 * question reads as the question, then the choice, under who made it.
 */
const activityEntry = (
	s: AgentSession,
	a: AgentActivity,
	activities: readonly AgentActivity[],
): DiscussionEntry => {
	const tag = a.severity ? `${a.type}/${a.severity}` : a.type;
	const question = answeredQuestion(a.context, activities);
	const body = question
		? `${parseQuestionBody(question.body).question}\n→ ${a.body}`
		: a.body;
	return {
		createdAt: a.createdAt,
		line: `**${a.author ?? s.agent}** (${tag}, ${a.createdAt}):\n${body}`,
	};
};

/**
 * Durable session activities across every session, as Discussion entries.
 * A per-session activity fetch that fails degrades to no activities for that
 * session (never fails the call).
 */
const sessionActivityEntries = async (
	jakePath: string,
	sessions: AgentSession[],
	strict: boolean,
): Promise<Result<DiscussionEntry[]>> => {
	const perSession = await Promise.all(
		sessions.map(async (s) => {
			const r = await PlannerSessions.getActivities(jakePath, s.id);
			if (!r.ok && strict)
				return err(
					new Error(
						"Cannot read context discussion activities; retry the bounded read.",
					),
				);
			const activities = r.ok ? r.value : [];
			return ok(
				SelectDurable.selectDurableActivities(activities).map((a) =>
					activityEntry(s, a, activities),
				),
			);
		}),
	);
	const entries: DiscussionEntry[] = [];
	for (const result of perSession) {
		if (!result.ok) return result;
		entries.push(...result.value);
	}
	return ok(entries);
};

/**
 * Discussion — ALL human comments and every typed entry no `latest` section
 * lifts (always) merged chronologically with the durable machine signal:
 *   - session-bearing tasks → durable session activities
 *   - session-less tasks    → the last 3 AI comments (pre-S4 heuristic)
 *
 * Human comments are the most load-bearing brief content (the steering left by
 * people) and carry NO other section, so they are ALWAYS included — the cap
 * bounds only the machine set, never the kept entries. A typed entry is kept
 * for the same reason: its writer gave it a kind to keep it. Work-log entries
 * are deliberately EXCLUDED — "Prior work" owns them.
 */
const discussionSection = (
	kept: DiscussionEntry[],
	machine: DiscussionEntry[],
	opts: ResolvedAssembleContextOpts,
): string | null => {
	const bounded =
		machine.length > opts.maxTimelineEntries
			? machine.slice(-opts.maxTimelineEntries)
			: machine;
	const merged = [...kept, ...bounded].sort(byCreatedAtAscEntry);
	if (merged.length === 0) return null;
	return `## Discussion\n\n${merged.map((e) => e.line).join("\n\n")}`;
};

type RenderedSection = {
	section: string;
	markdown: string | null;
};

const sourceRows = <T>(
	result: Result<T[]>,
	source: string,
	strict: boolean,
): Result<T[]> =>
	result.ok
		? result
		: strict
			? err(new Error(`Cannot read context ${source}; retry the bounded read.`))
			: ok([]);

/**
 * A kind projected as `latest`: its newest entry under the kind's title, author
 * and time as the Discussion prints them, the framing line, the body verbatim,
 * and a count of the older entries it supersedes. Null when there is none.
 */
const renderLatestSection = async (
	section: LatestKindSection,
	basePath: string,
	task: Task,
	strict: boolean,
): Promise<Result<string | null>> => {
	const entries = sourceRows(
		await PlannerComments.getEntries(basePath, task.id, {
			kind: section.kind.name,
		}),
		section.name,
		strict,
	);
	if (!entries.ok) return entries;
	const newest = entries.value.at(-1);
	if (newest === undefined) return ok(null);
	const earlier = entries.value.length - 1;
	return ok(
		[
			`## ${section.kind.title} from ${newest.author} · ${newest.createdAt}`,
			section.framing,
			newest.content,
			...(earlier > 0
				? [
						`${earlier} earlier ${section.kind.name} entr${earlier === 1 ? "y" : "ies"} on record.`,
					]
				: []),
		].join("\n\n"),
	);
};

const renderModuleSection = async (
	section: ModuleContextSection,
	basePath: string,
	task: Task,
	opts: ResolvedAssembleContextOpts,
	strict: boolean,
): Promise<Result<string | null>> => {
	try {
		const result = await section.render(basePath, task, opts);
		return result.ok || strict ? result : ok(null);
	} catch {
		return strict
			? err(
					new Error(
						`Cannot read context ${section.name}; retry the bounded read.`,
					),
				)
			: ok(null);
	}
};

const renderCoreSection = async (
	section: ContextSection,
	basePath: string,
	task: Task,
	opts: ResolvedAssembleContextOpts,
	strict: boolean,
): Promise<Result<string | null>> => {
	switch (section) {
		case "metadata":
			return ok(
				`# ${task.shortId ?? task.id}: ${task.title}\n\n${metadataLine(task)}`,
			);
		case "description":
			return ok(descriptionSection(task));
		case "upstream": {
			const links = sourceRows(
				await PlannerUpstreamLinks.getUpstreamLinksForTask(basePath, task.id),
				"upstream",
				strict,
			);
			return links.ok ? ok(upstreamSection(links.value)) : links;
		}
		case "position": {
			const [linksR, subtasksR] = await Promise.all([
				PlannerTaskLinks.getLinksForTask(basePath, task.id),
				opts.includeSubtasks
					? PlannerTasks.queryTasks(basePath, {
							parentTaskId: task.id,
							includeClosed: true,
							includeDeferred: true,
							limit: Number.MAX_SAFE_INTEGER,
						})
					: Promise.resolve(ok([] as Task[])),
			]);
			const links = sourceRows(linksR, "position links", strict);
			if (!links.ok) return links;
			const subtasks = sourceRows(subtasksR, "position subtasks", strict);
			if (!subtasks.ok) return subtasks;
			return positionSection(basePath, task, links.value, subtasks.value, {
				includeSubtasks: opts.includeSubtasks,
				strict,
			});
		}
		case "context": {
			const refs = sourceRows(
				await PlannerContextRefs.getContextRefs(basePath, task.id),
				"references",
				strict,
			);
			return refs.ok
				? ok(await contextSection(refs.value, opts, strict))
				: refs;
		}
		case "priorWork": {
			const logs = sourceRows(
				await PlannerWorkLogs.getWorkLogs(basePath, task.id),
				"prior work",
				strict,
			);
			return logs.ok ? ok(priorWorkSection(logs.value)) : logs;
		}
		case "discussion": {
			const [entriesR, sessionsR] = await Promise.all([
				PlannerComments.getEntries(basePath, task.id),
				PlannerSessions.querySessions(basePath, { taskId: task.id }),
			]);
			const entries = sourceRows(entriesR, "discussion comments", strict);
			if (!entries.ok) return entries;
			const sessions = sourceRows(sessionsR, "discussion sessions", strict);
			if (!sessions.ok) return sessions;
			const comments = entries.value.filter(
				(e) => e.kind === DEFAULT_ENTRY_KIND,
			);
			const machine =
				sessions.value.length > 0
					? await sessionActivityEntries(basePath, sessions.value, strict)
					: ok(lastAiCommentEntries(comments));
			if (!machine.ok) return machine;
			return ok(
				discussionSection(
					[...humanCommentEntries(comments), ...typedEntries(entries.value)],
					machine.value,
					opts,
				),
			);
		}
	}
};

/** Shared renderer: full reads degrade; bounded reads require selected sources. */
export const readContextSections = async (
	basePath: string,
	task: Task,
	opts: ResolvedAssembleContextOpts,
	sections: readonly string[],
	strict: boolean,
): Promise<Result<RenderedSection[]>> => {
	const registeredModules = new Map(
		Runtime.modules()
			.flatMap((module) => module.contextSections ?? [])
			.map((section) => [section.name, section]),
	);
	const latestKinds = new Map(
		Runtime.modules()
			.flatMap(Modules.latestSections)
			.map((section) => [section.name, section]),
	);
	const render = async (section: string): Promise<Result<string | null>> => {
		const contribution = registeredModules.get(section);
		if (contribution)
			return renderModuleSection(contribution, basePath, task, opts, strict);
		const latest = latestKinds.get(section);
		if (latest) return renderLatestSection(latest, basePath, task, strict);
		const core = ContextSectionSchema.safeParse(section);
		if (core.success)
			return renderCoreSection(core.data, basePath, task, opts, strict);
		return err(
			new Error(
				`Valid sections: ${registeredContextSections().join(", ")}. Unknown section (excerpt): ${section.slice(0, 80)}`,
			),
		);
	};
	try {
		const rendered = await Promise.all(
			sections.map(async (section) => ({
				section,
				result: await render(section),
			})),
		);
		const output: RenderedSection[] = [];
		for (const { section, result } of rendered) {
			if (!result.ok) return result;
			output.push({ section, markdown: result.value });
		}
		return ok(output);
	} catch (e) {
		return err(
			strict
				? new Error("Cannot assemble selected context sources; retry the read.")
				: e instanceof Error
					? e
					: new Error(String(e)),
		);
	}
};

// ── Public API ──────────────────────────────────────────────────────────────

export namespace Planner {
	/**
	 * Assemble an issue's full agent brief as markdown. Kind-agnostic (task and
	 * issue are both rows). ShortId is resolved to a ULID inside, so tRPC/MCP
	 * callers can pass either.
	 *
	 * @returns Result<string> — formatted markdown, embedded verbatim by consumers.
	 */
	export const assembleContext = traced(
		"planner.assembleContext",
		async (
			jakePath: string,
			taskIdInput: string,
			opts?: AssembleContextOpts,
		): Promise<Result<string>> => {
			const parsed = AssembleContextOptsSchema.safeParse(opts ?? {});
			if (!parsed.success) {
				return err(new Error(`Invalid opts: ${parsed.error.message}`));
			}
			const o = parsed.data;

			try {
				const idResult = await PlannerTasks.resolveTaskId(
					jakePath,
					taskIdInput,
				);
				if (!idResult.ok) return idResult;
				const taskId = idResult.value;

				const taskResult = await PlannerTasks.getTask(jakePath, taskId);
				if (!taskResult.ok) return taskResult;
				const task = taskResult.value;
				if (!task) return err(new Error(`Task not found: ${taskIdInput}`));

				const sections = await readContextSections(
					jakePath,
					task,
					o,
					registeredContextSections(),
					false,
				);
				if (!sections.ok) return sections;
				return ok(
					sections.value
						.flatMap(({ markdown }) => (markdown === null ? [] : [markdown]))
						.join("\n\n"),
				);
			} catch (e) {
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);
}
