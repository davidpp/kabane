// Claim decisions. Continuous, not in waves: every tick, each free slot under the concurrency cap
// takes the next ready subtask, so one slow session never holds the others back. Pure.
import { Harnesses } from "@cabane/acp";
import type { TaskPriority } from "@cabane/core";
import type { LoopPlan } from "./plan";

export namespace Scheduler {
	const RANK: Record<TaskPriority, number> = {
		urgent: 0,
		high: 1,
		normal: 2,
		low: 3,
	};

	/**
	 * Ready nodes in claim order: the ids in `first` in their own order, then priority, then the
	 * order they were planned in.
	 */
	const order = (
		ready: readonly LoopPlan.Node[],
		first: readonly string[],
	): LoopPlan.Node[] => {
		const asked = (node: LoopPlan.Node): number => {
			const at = first.indexOf(node.task.id);
			return at === -1 ? first.length : at;
		};
		return [...ready].sort(
			(a, b) =>
				asked(a) - asked(b) ||
				RANK[a.task.priority] - RANK[b.task.priority] ||
				a.task.createdAt.localeCompare(b.task.createdAt),
		);
	};

	/** What to claim now: the first `slots` of the ready frontier in claim order. */
	export const pick = (
		ready: readonly LoopPlan.Node[],
		slots: number,
		first: readonly string[] = [],
	): LoopPlan.Node[] => (slots > 0 ? order(ready, first).slice(0, slots) : []);

	/** The subtask's assignee when it names a harness kabane can drive, else the implementer. */
	export const harnessFor = (
		node: LoopPlan.Node,
		implementer: Harnesses.Id,
	): Harnesses.Id => {
		const assignee = node.task.assignee?.trim().toLowerCase();
		return assignee && Harnesses.isId(assignee) ? assignee : implementer;
	};
}
