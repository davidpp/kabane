// The plan a run works through: the parent issue's children and the `blocks`/`blocked_by`/`follows` links
// that order them, read from the tracker on every tick. An issue with no work under it is its own
// plan: its one work node is the issue itself, claimed, gated and settled as a subtask would be. Agents and humans may add, relink, close
// or park subtasks while the run goes, so nothing here is cached; a changed plan is a normal
// event, not an error.
//
// Findings are children tagged `finding`, which the lenses file. They are not work the scheduler
// claims: once the lenses have reviewed, one fixer session takes every open finding, most severe
// first. Severity (`p1`, `p2`, `p3`) orders that work and is reported; it does not decide it.
import {
	err,
	ok,
	Planner,
	type Result,
	type Task,
	type TaskLink,
	type TaskState,
} from "@cabane/core";

export namespace LoopPlan {
	export type Node = {
		task: Task;
		/** Ids of the tasks that must close before this one can be claimed, children or not. */
		blockedBy: string[];
		finding: boolean;
		severity: Severity | undefined;
	};

	export type Plan = {
		/** The run's target: the parent of the subtasks, or the single issue the plan is. */
		parent: Task;
		nodes: Node[];
		/** Blockers that are not children of the parent, by id. */
		outside: Map<string, Task>;
	};

	export const FINDING_TAG = "finding";
	/** Most severe first. */
	export const SEVERITIES = ["p1", "p2", "p3"] as const;
	export type Severity = (typeof SEVERITIES)[number];

	const CLAIMABLE: ReadonlySet<TaskState> = new Set(["inbox", "next"]);

	export const isClosed = (task: Task): boolean =>
		task.state === "done" || task.state === "cancelled";

	const hasTag = (task: Task, tag: string): boolean =>
		task.tags.some((t) => t.toLowerCase() === tag);

	/** What the scheduler claims and the plan needs closed: every child but the findings. */
	export const isWork = (node: Node): boolean => !node.finding;

	export const severityOf = (task: Task): Severity | undefined =>
		SEVERITIES.find((s) => hasTag(task, s));

	/** The lens that filed a finding: its tags other than `finding` and the severity. */
	export const lensOf = (task: Task): string | undefined =>
		task.tags.find((t) => {
			const tag = t.toLowerCase();
			return tag !== FINDING_TAG && !SEVERITIES.some((s) => s === tag);
		});

	/** The blockers a set of links gives `taskId`, both directions of the relation. */
	export const blockersOf = (
		taskId: string,
		links: readonly TaskLink[],
	): string[] => {
		const ids = links.flatMap((link) => {
			if (link.type === "blocks" && link.targetId === taskId)
				return [link.sourceId];
			if (
				(link.type === "blocked_by" || link.type === "follows") &&
				link.sourceId === taskId
			)
				return [link.targetId];
			return [];
		});
		return [...new Set(ids)];
	};

	export const node = (task: Task, blockedBy: string[]): Node => ({
		task,
		blockedBy,
		finding: hasTag(task, FINDING_TAG),
		severity: severityOf(task),
	});

	// A parent with more children than this is not a loop's plan; it is a backlog.
	const CHILD_LIMIT = 500;

	export const load = async (
		basePath: string,
		parentId: string,
	): Promise<Result<Plan>> => {
		const parent = await Planner.getTask(basePath, parentId);
		if (!parent.ok) return parent;
		if (!parent.value) return err(new Error(`No task ${parentId}`));
		const children = await Planner.queryTasks(basePath, {
			parentTaskId: parentId,
			includeClosed: true,
			includeDeferred: true,
			limit: CHILD_LIMIT,
		});
		if (!children.ok) return children;
		const sorted = [...children.value].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
		const nodes: Node[] = [];
		for (const task of sorted) {
			const links = await Planner.getLinksForTask(basePath, task.id);
			if (!links.ok) return links;
			nodes.push(node(task, blockersOf(task.id, links.value)));
		}
		// Work, even when it is itself a finding someone chose to run: it is what the run was started on.
		if (parent.value.kind === "issue" && !nodes.some(isWork)) {
			const links = await Planner.getLinksForTask(basePath, parentId);
			if (!links.ok) return links;
			nodes.unshift({
				...node(parent.value, blockersOf(parentId, links.value)),
				finding: false,
			});
		}
		const inside = new Set(nodes.map((n) => n.task.id));
		const outside = new Map<string, Task>();
		for (const id of new Set(nodes.flatMap((n) => n.blockedBy))) {
			if (inside.has(id)) continue;
			const blocker = await Planner.getTask(basePath, id);
			if (!blocker.ok) return blocker;
			// A blocker that no longer exists blocks nothing.
			if (blocker.value) outside.set(id, blocker.value);
		}
		return ok({ parent: parent.value, nodes, outside });
	};

	/**
	 * Whether the plan is a single issue: the target is its own work node. Findings the lenses
	 * filed under it do not make it a parent; a work child does, on the next read.
	 */
	export const single = (plan: Plan): boolean =>
		plan.nodes.some((n) => n.task.id === plan.parent.id);

	/**
	 * Whether `task`, as the tracker holds it now, is still work of `plan`: a child that is not a
	 * finding, or the target of a single-issue plan.
	 */
	export const isWorkOf = (plan: Plan, task: Task): boolean =>
		task.id === plan.parent.id
			? single(plan)
			: task.parentTaskId === plan.parent.id && !hasTag(task, FINDING_TAG);

	const byId = (plan: Plan): Map<string, Task> => {
		const map = new Map(plan.outside);
		for (const n of plan.nodes) map.set(n.task.id, n.task);
		return map;
	};

	const resolved = (tasks: Map<string, Task>, id: string): boolean => {
		const task = tasks.get(id);
		return task === undefined || isClosed(task);
	};

	const NOTHING: ReadonlySet<string> = new Set();

	const deferred = (task: Task, now: Date): boolean =>
		task.deferUntil !== undefined &&
		Date.parse(task.deferUntil) > now.getTime();

	/** A live claim may only continue or release the agent work it still owns. */
	export const isActive = (task: Task, harness: string): boolean =>
		task.kind === "issue" &&
		task.state === "in_progress" &&
		task.assignee === harness;

	/** Task-local eligibility; human work stays in the plan but is never dispatched. */
	export const canClaim = (task: Task, now: Date): boolean =>
		task.kind === "issue" && CLAIMABLE.has(task.state) && !deferred(task, now);

	/**
	 * The ready frontier: open agent work in a claimable state (`inbox`, `next`), not deferred, not
	 * already held by one of the run's live sessions, whose every blocker is closed and released
	 * by its live claim (including gates). A subtask
	 * someone moved to `in_progress`, `waiting` or `someday` is theirs, not the run's, and one the
	 * human skipped is never the run's.
	 */
	export const frontier = (
		plan: Plan,
		live: ReadonlySet<string>,
		now: Date,
		skipped: ReadonlySet<string> = NOTHING,
	): Node[] => {
		const tasks = byId(plan);
		return plan.nodes.filter(
			(n) =>
				isWork(n) &&
				canClaim(n.task, now) &&
				!live.has(n.task.id) &&
				!skipped.has(n.task.id) &&
				n.blockedBy.every((id) => !live.has(id) && resolved(tasks, id)),
		);
	};

	/**
	 * Something that holds a run that cannot move: its short id, why it holds the run when that is
	 * more than being open (`someday`, `skipped`, `outside the plan`), and whether a human parked or
	 * took it. The run never overrules a human's parking, so only a human releases a parked one.
	 */
	export type Holder = { id: string; why?: string; parked: boolean };

	export type Health =
		| { kind: "moving" }
		| { kind: "deadlocked"; cycle: string[] }
		| { kind: "waiting"; on: Holder[] };

	/** `JCAB-64 (someday)`: a holder as the header and the trace name it. */
	export const holder = (h: Holder): string =>
		h.why === undefined ? h.id : `${h.id} (${h.why})`;

	/** Whether only a human can release the run: it waits on something, and a human parked all of it. */
	export const parkedOnly = (on: readonly Holder[]): boolean =>
		on.length > 0 && on.every((h) => h.parked);

	const label = (task: Task): string => task.shortId ?? task.id;

	/** A cycle among open work, as task ids in order, or undefined when the open graph is acyclic. */
	export const cycle = (plan: Plan): string[] | undefined => {
		const open = new Map(
			plan.nodes
				.filter((n) => isWork(n) && !isClosed(n.task))
				.map((n) => [n.task.id, n]),
		);
		const state = new Map<string, "visiting" | "done">();
		const stack: string[] = [];
		const visit = (id: string): string[] | undefined => {
			if (state.get(id) === "done") return undefined;
			if (state.get(id) === "visiting") return stack.slice(stack.indexOf(id));
			state.set(id, "visiting");
			stack.push(id);
			for (const next of open.get(id)?.blockedBy ?? []) {
				if (!open.has(next)) continue;
				const found = visit(next);
				if (found) return found;
			}
			stack.pop();
			state.set(id, "done");
			return undefined;
		};
		for (const id of open.keys()) {
			const found = visit(id);
			if (found) return found;
		}
		return undefined;
	};

	/**
	 * Why a run with open work and nothing claimable or live cannot move. A cycle among open work
	 * never resolves by itself: deadlocked. Anything else is held by something outside the run
	 * (a subtask someone parked or took, a deferred one, a skipped one, an open blocker outside the
	 * plan), and a human or another agent can release it: waiting.
	 */
	export const health = (
		plan: Plan,
		live: ReadonlySet<string>,
		now: Date,
		skipped: ReadonlySet<string> = NOTHING,
	): Health => {
		if (live.size > 0 || frontier(plan, live, now, skipped).length > 0)
			return { kind: "moving" };
		const loop = cycle(plan);
		if (loop) {
			const tasks = byId(plan);
			return {
				kind: "deadlocked",
				cycle: loop.map((id) => {
					const task = tasks.get(id);
					return task ? label(task) : id;
				}),
			};
		}
		const tasks = byId(plan);
		const holders = new Map<string, Holder>();
		const hold = (task: Task, why: string, parked = false): void => {
			if (!holders.has(task.id))
				holders.set(task.id, { id: label(task), why, parked });
		};
		for (const n of plan.nodes) {
			if (!isWork(n) || isClosed(n.task)) continue;
			if (skipped.has(n.task.id)) hold(n.task, "skipped");
			else if (!canClaim(n.task, now)) {
				const why = unclaimable(n.task);
				hold(n.task, why.why, why.parked);
			}
			for (const id of n.blockedBy) {
				const blocker = plan.outside.get(id);
				if (blocker && !resolved(tasks, id)) hold(blocker, "outside the plan");
			}
		}
		return { kind: "waiting", on: [...holders.values()] };
	};

	// Why open work the run may not claim is not claimable. A live claim's subtask is never asked:
	// a run with one is moving, so work in progress here is someone else's.
	const unclaimable = (task: Task): { why: string; parked: boolean } => {
		if (task.kind !== "issue") return { why: "a human's task", parked: false };
		if (task.state === "in_progress")
			return { why: "in_progress, not the run's", parked: true };
		if (task.state === "someday" || task.state === "waiting")
			return { why: task.state, parked: true };
		return {
			why: `deferred until ${task.deferUntil?.slice(0, 10) ?? "later"}`,
			parked: false,
		};
	};

	/**
	 * Closed children ids, for the stall detector's progress mark: a finding the fixer closes is
	 * progress as much as a subtask is.
	 */
	export const closed = (plan: Plan): string[] =>
		plan.nodes.filter((n) => isClosed(n.task)).map((n) => n.task.id);

	const rank = (node: Node): number =>
		node.severity === undefined
			? SEVERITIES.length
			: SEVERITIES.indexOf(node.severity);

	/**
	 * The findings the fixer takes, most severe first, then oldest first: every open one the run
	 * may claim. One a human parked, deferred, took or skipped is theirs, as a subtask would be.
	 */
	export const fixable = (
		plan: Plan,
		now: Date,
		skipped: ReadonlySet<string> = NOTHING,
	): Node[] =>
		plan.nodes
			.filter(
				(n) => n.finding && canClaim(n.task, now) && !skipped.has(n.task.id),
			)
			.sort((a, b) => rank(a) - rank(b));

	/** What the lenses filed: every finding, and how many are still open. */
	export const findings = (plan: Plan): { total: number; open: number } => {
		const found = plan.nodes.filter((n) => n.finding);
		return {
			total: found.length,
			open: found.filter((n) => !isClosed(n.task)).length,
		};
	};
}
