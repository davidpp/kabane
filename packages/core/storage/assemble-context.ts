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

import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import {
	type AgentSession,
	type AssembleContextOpts,
	AssembleContextOptsSchema,
	type ResolvedAssembleContextOpts,
	type Task,
	type TaskComment,
	type TaskContextRef,
	type TaskLink,
	type TaskWorkLog,
	type UpstreamLink,
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
 * Position: parent · blockers (w/ states) · blocks · subtask states.
 * Blocking semantics mirror the loop's readiness logic (briefing/dag.ts):
 * - blocks:     source blocks target → target depends on source
 * - blocked_by: source blocked_by target → source depends on target
 * - follows:    source follows target → source depends on target
 */
const positionSection = async (
	jakePath: string,
	task: Task,
	links: TaskLink[],
	subtasks: Task[],
	includeSubtasks: boolean,
): Promise<string | null> => {
	const blockerIds = new Set<string>();
	const blocksIds = new Set<string>();
	for (const link of links) {
		// What this task is blocked by (its dependencies).
		if (link.type === "blocks" && link.targetId === task.id)
			blockerIds.add(link.sourceId);
		if (link.type === "blocked_by" && link.sourceId === task.id)
			blockerIds.add(link.targetId);
		if (link.type === "follows" && link.sourceId === task.id)
			blockerIds.add(link.targetId);
		// What this task blocks (its dependents).
		if (link.type === "blocks" && link.sourceId === task.id)
			blocksIds.add(link.targetId);
		if (link.type === "blocked_by" && link.targetId === task.id)
			blocksIds.add(link.sourceId);
		if (link.type === "follows" && link.targetId === task.id)
			blocksIds.add(link.sourceId);
	}

	const neighborIds = new Set<string>([...blockerIds, ...blocksIds]);
	if (task.parentTaskId) neighborIds.add(task.parentTaskId);

	const fetched = await Promise.all(
		[...neighborIds].map(async (id) => {
			const r = await PlannerTasks.getTask(jakePath, id);
			return r.ok && r.value ? ([id, r.value] as const) : null;
		}),
	);
	const neighbors = new Map<string, Task>(
		fetched.filter((e): e is readonly [string, Task] => e !== null),
	);

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

	if (lines.length === 0) return null;
	return `## Position\n\n${lines.join("\n")}`;
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
		// status === "pointer" → fall through to pointer rendering
	}

	// Pointer: non-file scheme, deref off, total-cap exhausted, or unreadable.
	return { block: `${header}\n${ref.uri}${note}`, chars: 0 };
};

const contextSection = async (
	refs: TaskContextRef[],
	opts: ResolvedAssembleContextOpts,
): Promise<string | null> => {
	if (refs.length === 0) return null;
	const blocks: string[] = [];
	let totalUsed = 0;
	for (const ref of refs) {
		const { block, chars } = await contextRefBlock(ref, opts, totalUsed);
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
 * Durable session activities across every session, as Discussion entries.
 * A per-session activity fetch that fails degrades to no activities for that
 * session (never fails the call).
 */
const sessionActivityEntries = async (
	jakePath: string,
	sessions: AgentSession[],
): Promise<DiscussionEntry[]> => {
	const perSession = await Promise.all(
		sessions.map(async (s) => {
			const r = await PlannerSessions.getActivities(jakePath, s.id);
			const activities = r.ok ? r.value : [];
			return SelectDurable.selectDurableActivities(activities).map((a) => {
				const tag = a.severity ? `${a.type}/${a.severity}` : a.type;
				return {
					createdAt: a.createdAt,
					line: `**${s.agent}** (${tag}, ${a.createdAt}):\n${a.body}`,
				};
			});
		}),
	);
	return perSession.flat();
};

/**
 * Discussion — ALL human comments (always) merged chronologically with the
 * durable machine signal:
 *   - session-bearing tasks → durable session activities
 *   - session-less tasks    → the last 3 AI comments (pre-S4 heuristic)
 *
 * Human comments are the most load-bearing brief content (the steering left by
 * people) and carry NO other section, so they are ALWAYS included — the cap
 * bounds only the machine set, never the human comments. Work-log entries are
 * deliberately EXCLUDED — "Prior work" owns them.
 */
const discussionSection = (
	human: DiscussionEntry[],
	machine: DiscussionEntry[],
	opts: ResolvedAssembleContextOpts,
): string | null => {
	const bounded =
		machine.length > opts.maxTimelineEntries
			? machine.slice(-opts.maxTimelineEntries)
			: machine;
	const merged = [...human, ...bounded].sort(byCreatedAtAscEntry);
	if (merged.length === 0) return null;
	return `## Discussion\n\n${merged.map((e) => e.line).join("\n\n")}`;
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

				// Independent per-source fetch — a failed source degrades to empty.
				const [
					linksR,
					subtasksR,
					refsR,
					workLogsR,
					commentsR,
					sessionsR,
					upstreamLinksR,
				] = await Promise.all([
					PlannerTaskLinks.getLinksForTask(jakePath, taskId),
					o.includeSubtasks
						? PlannerTasks.queryTasks(jakePath, {
								parentTaskId: taskId,
								includeClosed: true,
							})
						: Promise.resolve(ok([] as Task[])),
					PlannerContextRefs.getContextRefs(jakePath, taskId),
					PlannerWorkLogs.getWorkLogs(jakePath, taskId),
					PlannerComments.getComments(jakePath, taskId),
					PlannerSessions.querySessions(jakePath, { taskId }),
					PlannerUpstreamLinks.getUpstreamLinksForTask(jakePath, taskId),
				]);

				const links = linksR.ok ? linksR.value : [];
				const subtasks = subtasksR.ok ? subtasksR.value : [];
				const refs = refsR.ok ? refsR.value : [];
				const workLogs = workLogsR.ok ? workLogsR.value : [];
				const comments = commentsR.ok ? commentsR.value : [];
				const sessions = sessionsR.ok ? sessionsR.value : [];
				const upstreamLinks = upstreamLinksR.ok ? upstreamLinksR.value : [];

				// ALL human comments always; the machine signal is the durable
				// session activities (session-bearing) or the last-3-AI heuristic
				// (session-less). Merged chronologically in discussionSection.
				const human = humanCommentEntries(comments);
				const machine =
					sessions.length > 0
						? await sessionActivityEntries(jakePath, sessions)
						: lastAiCommentEntries(comments);
				const discussion = discussionSection(human, machine, o);

				const sections: (string | null)[] = [
					`# ${task.shortId ?? task.id}: ${task.title}`,
					metadataLine(task),
					descriptionSection(task),
					upstreamSection(upstreamLinks),
					await positionSection(
						jakePath,
						task,
						links,
						subtasks,
						o.includeSubtasks,
					),
					await contextSection(refs, o),
					priorWorkSection(workLogs),
					discussion,
				];

				return ok(sections.filter((s): s is string => s !== null).join("\n\n"));
			} catch (e) {
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);
}
