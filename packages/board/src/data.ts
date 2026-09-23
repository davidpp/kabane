// The one module the whole board reads tracker data through. Everything talks to storage via the
// Planner.* functions over the configured Db provider (same path as the CLI — no server required),
// so a future swap to a remote client touches this file only.
import {
	type AgentActivity,
	type AgentSession,
	err,
	type ItemKind,
	ok,
	Planner,
	type Result,
	TASK_STATE_DISPLAY,
	type Task,
	type TaskComment,
	type TaskLink,
	type TaskQuery,
	type TaskState,
	type TaskWorkLog,
	type UpstreamLink,
} from "@cabane/core";

export namespace BoardData {
	// Sections rendered top-to-bottom (linear-tui grouped-list order) — every one of the seven states,
	// so the board can reach anything it can write. Unresolved work leads, `someday` sits under it as
	// the parked backlog, and the closed archive trails. WHICH of these render is the `f` status
	// filter's business (see BoardNav.visibleSections), not this list's: it only fixes the order.
	// This is the DISPLAY order — the `[`/`]` state move uses the GTD progression below instead, so
	// a reordered display never changes what "next state" means.
	export const SECTION_STATES = [
		"in_progress",
		"next",
		"inbox",
		"waiting",
		"someday",
		"done",
		"cancelled",
	] as const satisfies readonly TaskState[];

	// Logical GTD progression for `[`/`]` (prev/next state), independent of the display order above.
	export const STATE_PROGRESSION = [
		"inbox",
		"next",
		"in_progress",
		"waiting",
		"done",
	] as const satisfies readonly TaskState[];

	export type SectionState = (typeof SECTION_STATES)[number];

	// The two lifecycle buckets. `closed` is exactly what core's `includeClosed: false` excludes
	// (storage/tasks.ts: `state NOT IN ('done', 'cancelled')`), so the board's split and the query
	// layer's agree by construction rather than by coincidence. Everything else — someday included —
	// is unresolved: parked is not finished.
	const CLOSED_STATES: readonly TaskState[] = ["done", "cancelled"];

	export const isClosed = (state: TaskState): boolean =>
		CLOSED_STATES.includes(state);

	// The archive window for instant client-side tier-1 search, shared by done and cancelled. FTS
	// (tier 2) owns the deep archive; the loaded window is just the instant tier — 50 recent each is
	// enough for "did X land?" while FTS surfaces the full 800+ backlog within ~200ms.
	const ARCHIVE_LIMIT = 50;
	const OPEN_LIMIT = 100;

	// A visible top-level row plus its (depth-2, no deeper) subtasks. Planner nesting is one level, so
	// `children` never nest further.
	export type BoardRow = {
		task: Task;
		children: Task[];
	};

	export type BoardSection = {
		state: SectionState;
		label: string;
		rows: BoardRow[];
	};

	export type BoardFilters = {
		scopeUri?: string;
		kind?: ItemKind;
	};

	export type ScopeInfo = {
		scopeUri: string;
		label: string;
	};

	// How a host maps the board's cwd to a scope. Absent → the board shows all scopes.
	export type ScopeResolver = (cwd: string) => Promise<ScopeInfo | null>;

	// Pure list assembly (the tree seam — unit-tested without a DB). Groups top-level tasks into their
	// state sections and attaches children under their parent. Rules:
	//   - a subtask attached under its parent appears ONLY there (deduped from its own section);
	//   - a subtask that was NOT attached stays a top-level row in its own state section — its parent
	//     is past the cap, or closed and therefore never a subtask root. board.tsx marks such a row
	//     with its parent id so it doesn't read as a genuine root item;
	//   - empty sections are dropped.
	// `tasksByState` are the per-state query results (section candidates, the archive already capped);
	// `subtasks` are the children of the visible top-level tasks (fetched separately so done children
	// under an open parent still show).
	export const assembleSections = (
		tasksByState: Partial<Record<SectionState, Task[]>>,
		subtasks: Task[],
	): BoardSection[] => {
		const visibleIds = new Set<string>();
		for (const state of SECTION_STATES) {
			for (const task of tasksByState[state] ?? []) visibleIds.add(task.id);
		}

		const childrenByParent = new Map<string, Task[]>();
		// The ids that ACTUALLY ended up under a parent. This, not "the parent exists", is what earns
		// the dedupe below: a subtask only renders under its parent when it is in that parent's list.
		const attachedIds = new Set<string>();
		for (const sub of subtasks) {
			const parentId = sub.parentTaskId;
			if (!parentId || !visibleIds.has(parentId)) continue;
			const list = childrenByParent.get(parentId) ?? [];
			list.push(sub);
			childrenByParent.set(parentId, list);
			attachedIds.add(sub.id);
		}

		const sections: BoardSection[] = [];
		for (const state of SECTION_STATES) {
			const rows: BoardRow[] = [];
			for (const task of tasksByState[state] ?? []) {
				// Deduped: a child that is rendering under its parent doesn't render twice. Keyed on the
				// child actually being attached, NOT on its parent merely existing — a closed parent is
				// never a subtask root, so its children were never fetched and nothing would re-attach
				// them. Testing the parent here dropped them from both places (JCAB-30).
				if (attachedIds.has(task.id)) continue;
				rows.push({ task, children: childrenByParent.get(task.id) ?? [] });
			}
			if (rows.length > 0) {
				sections.push({
					state,
					label: TASK_STATE_DISPLAY[state].label,
					rows,
				});
			}
		}
		return sections;
	};

	// Load the grouped list: one query per state for the section rows, then one query per top-level
	// task for its subtasks. Two treatments, keyed off the lifecycle rather than off one state name:
	// unresolved states (someday included) load as a tree, ordered by creation; the closed archive
	// loads capped and recency-ordered. Planner nesting is one level, so tasks that already have a
	// parent can't be parents themselves and are skipped as query roots.
	export const loadBoard = async (
		basePath: string,
		filters: BoardFilters = {},
	): Promise<Result<BoardSection[]>> => {
		const tasksByState: Partial<Record<SectionState, Task[]>> = {};
		const parentIds: string[] = [];
		for (const state of SECTION_STATES) {
			const closed = isClosed(state);
			const query: Partial<TaskQuery> = {
				state,
				kind: filters.kind,
				scopeUri: filters.scopeUri,
				includeClosed: closed,
				limit: closed ? ARCHIVE_LIMIT : OPEN_LIMIT,
				orderBy: closed ? "updatedAt" : "createdAt",
				orderDir: "desc",
			};
			const result = await Planner.queryTasks(basePath, query);
			if (!result.ok) return result;
			tasksByState[state] = result.value;
			// Archive rows render FLAT (search results, not a tree): skipping them as subtask roots
			// keeps the two archive windows from adding a per-parent query each to every 5s poll.
			// Someday is NOT archive — a parked parent still has children worth seeing.
			if (closed) continue;
			for (const task of result.value) {
				if (!task.parentTaskId) parentIds.push(task.id);
			}
		}

		const subtasks: Task[] = [];
		for (const parentId of parentIds) {
			const result = await Planner.queryTasks(basePath, {
				parentTaskId: parentId,
				kind: filters.kind,
				includeClosed: true,
				limit: OPEN_LIMIT,
				orderBy: "createdAt",
				orderDir: "asc",
			});
			if (!result.ok) return result;
			subtasks.push(...result.value);
		}

		return ok(assembleSections(tasksByState, subtasks));
	};

	// FTS5 search for tier-2 results (description/tag matches, done beyond the loaded window, open
	// tasks beyond the per-state caps). Returns flat tasks — the board merge fn handles section placement.
	export const searchBoard = async (
		basePath: string,
		query: string,
		filters: BoardFilters = {},
	): Promise<Result<Task[]>> => {
		return Planner.searchTasks(basePath, query, {
			scopeUri: filters.scopeUri,
			limit: 50,
		});
	};

	// Full assembled brief for a task: what `y` copies and the copilot reads. The agent's view of a
	// task; the detail view reads the records instead (taskDetail).
	export const taskBrief = async (
		basePath: string,
		id: string,
	): Promise<Result<string>> => {
		return Planner.assembleContext(basePath, id);
	};

	/** One agent session on a task and what it recorded, oldest activity first. */
	export type SessionRecords = {
		session: AgentSession;
		activities: AgentActivity[];
	};

	/**
	 * Everything the detail view shows about a task: the same reads the agent brief makes, handed
	 * over as records so the view can place each one once.
	 */
	export type DetailRecords = {
		task: Task;
		comments: TaskComment[];
		workLogs: TaskWorkLog[];
		sessions: SessionRecords[];
		links: TaskLink[];
		// The parent and every linked task, for naming them in the meta lines.
		neighbors: Task[];
		upstream: UpstreamLink[];
	};

	const sessionRecords = async (
		basePath: string,
		session: AgentSession,
	): Promise<Result<SessionRecords>> => {
		const activities = await Planner.getActivities(basePath, session.id);
		return activities.ok
			? ok({ session, activities: activities.value })
			: activities;
	};

	const neighborIds = (task: Task, links: TaskLink[]): string[] => {
		const ids = new Set<string>();
		if (task.parentTaskId) ids.add(task.parentTaskId);
		for (const link of links)
			ids.add(link.sourceId === task.id ? link.targetId : link.sourceId);
		ids.delete(task.id);
		return [...ids];
	};

	// The detail view's records for one task. A read that fails fails the whole load: a view that
	// silently dropped the comments would read as "no comments", which is not true.
	export const taskDetail = async (
		basePath: string,
		id: string,
	): Promise<Result<DetailRecords>> => {
		const task = await Planner.getTask(basePath, id);
		if (!task.ok) return task;
		if (!task.value) return err(new Error(`task ${id} not found`));
		const [comments, workLogs, sessions, links, upstream] = await Promise.all([
			Planner.getComments(basePath, id),
			Planner.getWorkLogs(basePath, id),
			Planner.querySessions(basePath, { taskId: id }),
			Planner.getLinksForTask(basePath, id),
			Planner.getUpstreamLinksForTask(basePath, id),
		]);
		if (!comments.ok) return comments;
		if (!workLogs.ok) return workLogs;
		if (!sessions.ok) return sessions;
		if (!links.ok) return links;
		if (!upstream.ok) return upstream;
		const perSession: SessionRecords[] = [];
		for (const session of sessions.value) {
			const records = await sessionRecords(basePath, session);
			if (!records.ok) return records;
			perSession.push(records.value);
		}
		const neighbors = await Planner.getTasks(
			basePath,
			neighborIds(task.value, links.value),
		);
		if (!neighbors.ok) return neighbors;
		return ok({
			task: task.value,
			comments: comments.value,
			workLogs: workLogs.value,
			sessions: perSession,
			links: links.value,
			neighbors: neighbors.value,
			upstream: upstream.value,
		});
	};

	// Every task id in the loaded sections, parents and children alike.
	const taskIdsOf = (sections: BoardSection[]): string[] => {
		const ids: string[] = [];
		for (const section of sections) {
			for (const row of section.rows) {
				ids.push(row.task.id);
				for (const child of row.children) ids.push(child.id);
			}
		}
		return ids;
	};

	// Which of the loaded tasks point at an external issue. A set of ids, not the links themselves:
	// the row asks one yes/no question, and one query answers it for every row at once. WHICH issue a
	// row points at is read on demand, when something actually opens it.
	export const loadLinkedTaskIds = async (
		basePath: string,
		sections: BoardSection[],
	): Promise<Result<Set<string>>> => {
		const summaries = await Planner.getUpstreamSummariesForTasks(
			basePath,
			taskIdsOf(sections),
		);
		if (!summaries.ok) return summaries;
		return ok(new Set(summaries.value.map((summary) => summary.taskId)));
	};

	// The external issues one task points at, in creation order. Read on the keypress that opens one,
	// so the board's poll never pays for it.
	export const taskLinks = async (
		basePath: string,
		id: string,
	): Promise<Result<UpstreamLink[]>> => {
		return Planner.getUpstreamLinksForTask(basePath, id);
	};

	// State mutations (used by the keyboard actions).
	export const setTaskState = async (
		basePath: string,
		id: string,
		state: TaskState,
	): Promise<Result<Task | null>> => {
		return Planner.updateTask(basePath, id, { state });
	};

	export const markDone = async (
		basePath: string,
		id: string,
	): Promise<Result<Task | null>> => {
		return Planner.updateTask(basePath, id, { state: "done" });
	};

	// The planner's review op (mirrors tRPC `review` / `jake plan review`): clears the needsReview flag
	// and stamps the verification record — NOT a bare boolean flip. Review is a flag lifecycle, never a
	// state (planner CLAUDE.md: `needs_review` is not one of the 7 canonical states).
	export const markReviewed = async (
		basePath: string,
		id: string,
		reviewer = "human",
	): Promise<Result<Task | null>> => {
		return Planner.updateTask(basePath, id, {
			needsReview: false,
			verification: {
				status: "passed",
				method: "manual",
				verifiedAt: new Date().toISOString(),
				verifiedBy: reviewer,
			},
		});
	};

	// Apply a ctrl-z reverse patch — every board mutation is one updateTask, so its inverse is too. The
	// patch is typed locally (not from nav) to keep data.ts the lower layer with no cycle back to the reducer.
	export const applyUndo = async (
		basePath: string,
		id: string,
		patch: Partial<Pick<Task, "state" | "needsReview" | "verification">>,
	): Promise<Result<Task | null>> => {
		return Planner.updateTask(basePath, id, patch);
	};
}
