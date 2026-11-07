// An issue's checklist, as the loop reads it: the steps of one change, which the claim's session
// works in order in the claim's tree and ticks as each lands (`@cabane/checklist`). The issue is
// done only once every item is ticked, so a session that closes it with items open has it
// reopened, and the checkpoint after a green pass names the items ticked since the last one.
import {
	Checklist,
	type ChecklistItemView,
	checklistModule,
} from "@cabane/checklist";
import { ok, Planner, type Result, Runtime, type Task } from "@cabane/core";

export namespace Checklists {
	export type Item = ChecklistItemView;

	/**
	 * `taskId`'s live items in list order. A host that does not register the checklist module has
	 * no checklist table, so no issue of its has items.
	 */
	export const of = (
		basePath: string,
		taskId: string,
	): Promise<Result<Item[]>> =>
		Runtime.modules().some((module) => module.name === checklistModule.name)
			? Checklist.list(basePath, taskId)
			: Promise.resolve(ok([]));

	export const open = (items: readonly Item[]): Item[] =>
		items.filter((item) => !item.done);

	/** The items ticked after `since`, an ISO time, in list order. */
	export const tickedSince = (items: readonly Item[], since: string): Item[] =>
		items.filter((item) => item.doneAt !== undefined && item.doneAt > since);

	/**
	 * Refuse `task` closed as done with items still open, when `harness` owns it: put it back in
	 * progress and say which items are open. Empty when there is nothing to refuse. A done issue
	 * under another assignee was closed by whoever that is, which is theirs to decide.
	 */
	export const refuseDone = async (
		basePath: string,
		task: Task,
		harness: string,
	): Promise<Result<Item[]>> => {
		if (task.state !== "done" || task.assignee !== harness) return ok([]);
		const items = await of(basePath, task.id);
		if (!items.ok) return items;
		const left = open(items.value);
		if (left.length === 0) return ok([]);
		const reopened = await Planner.updateTask(basePath, task.id, {
			state: "in_progress",
		});
		return reopened.ok ? ok(left) : reopened;
	};
}
