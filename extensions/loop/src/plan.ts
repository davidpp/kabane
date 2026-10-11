// The plan a run works through: the parent issue's children and the `blocks`/`blocked_by` links
// that order them, read from the tracker on every tick. Agents and humans may add, relink, close
// or park subtasks while the run goes, so nothing here is cached; a changed plan is a normal
// event, not an error.
//
// Findings are children tagged `finding`. An open `p1` finding is work (it keeps the run open and
// gets claimed like any subtask); `p2` and `p3` findings are on the record and are not claimed.
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
		p1: boolean;
	};

	export type Plan = {
		parent: Task;
		nodes: Node[];
		/** Blockers that are not children of the parent, by id. */
		outside: Map<string, Task>;
	};

	export const FINDING_TAG = "finding";
	export const P1_TAG = "p1";

	const CLAIMABLE: ReadonlySet<TaskState> = new Set(["inbox", "next"]);

	export const isClosed = (task: Task): boolean =>
		task.state === "done" || task.state === "cancelled";

	const hasTag = (task: Task, tag: string): boolean =>
		task.tags.some((t) => t.toLowerCase() === tag);

	/** Whether the node is the run's to finish: every subtask, and the `p1` findings. */
	export const isWork = (node: Node): boolean => !node.finding || node.p1;

	/** The blockers a set of links gives `taskId`, both directions of the relation. */
	export const blockersOf = (
		taskId: string,
		links: readonly TaskLink[],
	): string[] => {
		const ids = links.flatMap((link) => {
			if (link.type === "blocks" && link.targetId === taskId)
				return [link.sourceId];
			if (link.type === "blocked_by" && link.sourceId === taskId)
				return [link.targetId];
			return [];
		});
		return [...new Set(ids)];
	};

	export const node = (task: Task, blockedBy: string[]): Node => ({
		task,
		blockedBy,
		finding: hasTag(task, FINDING_TAG),
		p1: hasTag(task, P1_TAG),
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

	/**
	 * The ready frontier: open work in a claimable state (`inbox`, `next`), not deferred, not
	 * already held by one of the run's live sessions, whose every blocker is closed. A subtask
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
				CLAIMABLE.has(n.task.state) &&
				!deferred(n.task, now) &&
				!live.has(n.task.id) &&
				!skipped.has(n.task.id) &&
				n.blockedBy.every((id) => resolved(tasks, id)),
		);
	};

	export type Health =
		| { kind: "moving" }
		| { kind: "deadlocked"; cycle: string[] }
		| { kind: "waiting"; on: string[] };

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
		const holders = new Set<string>();
		for (const n of plan.nodes) {
			if (!isWork(n) || isClosed(n.task)) continue;
			if (skipped.has(n.task.id)) holders.add(`${label(n.task)} (skipped)`);
			else if (!CLAIMABLE.has(n.task.state) || deferred(n.task, now))
				holders.add(label(n.task));
			for (const id of n.blockedBy) {
				const blocker = plan.outside.get(id);
				if (blocker && !resolved(tasks, id)) holders.add(label(blocker));
			}
		}
		return { kind: "waiting", on: [...holders] };
	};

	/** Closed work ids, for the stall detector's progress mark. */
	export const closedWork = (plan: Plan): string[] =>
		plan.nodes
			.filter((n) => isWork(n) && isClosed(n.task))
			.map((n) => n.task.id);

	/** What the lenses filed: every finding, and the open `p1`s among them. */
	export const findings = (plan: Plan): { total: number; openP1: number } => {
		const found = plan.nodes.filter((n) => n.finding);
		return {
			total: found.length,
			openP1: found.filter((n) => n.p1 && !isClosed(n.task)).length,
		};
	};
}
