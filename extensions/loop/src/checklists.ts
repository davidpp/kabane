// An issue's checklist, as the loop reads it: the steps of one change, which the claim's session
// works in order in the claim's tree and ticks as each lands (`@cabane/checklist`). The issue is
// done only once every item is ticked, so a session that closes it with items open has it
// reopened, and the checkpoint after a green pass names the items ticked since the last one.
import { CopilotInstructions } from "@cabane/acp";
import {
	Checklist,
	type ChecklistItemView,
	checklistModule,
} from "@cabane/checklist";
import { ok, Planner, type Result, Runtime, type Task } from "@cabane/core";

export namespace Checklists {
	export type Item = ChecklistItemView;

	const registered = (): boolean =>
		Runtime.modules().some((module) => module.name === checklistModule.name);

	/**
	 * `taskId`'s live items in list order. A host that does not register the checklist module has
	 * no checklist table, so no issue of its has items.
	 */
	export const of = (
		basePath: string,
		taskId: string,
	): Promise<Result<Item[]>> =>
		registered() ? Checklist.list(basePath, taskId) : Promise.resolve(ok([]));

	/**
	 * How far the checklists of `taskIds` are ticked, as one string that changes with every tick or
	 * untick: progress for the stall detector, apart from the tree's fingerprint. Empty when the host
	 * has no checklist module or the read fails, which leaves the rest of the mark to speak.
	 */
	export const progress = async (
		basePath: string,
		taskIds: readonly string[],
	): Promise<string> => {
		if (!registered()) return "";
		const all = await Checklist.progress(basePath);
		if (!all.ok) return "";
		return [...new Set(taskIds)]
			.sort()
			.flatMap((id) => {
				const of = all.value.get(id);
				return of ? [`${id}:${of.done}/${of.total}`] : [];
			})
			.join(",");
	};

	export const open = (items: readonly Item[]): Item[] =>
		items.filter((item) => !item.done);

	/** The items ticked after `since`, an ISO time, in list order. */
	export const tickedSince = (items: readonly Item[], since: string): Item[] =>
		items.filter((item) => item.doneAt !== undefined && item.doneAt > since);

	/**
	 * Refuse an issue closed as done with items still open by `harness`'s own session: put it back
	 * in progress and say which items are open. A personal task is never reopened. Empty when there is nothing to refuse. A close by
	 * anyone else, a human above all, is their decision and stands.
	 *
	 * Who closed it is the row's last writer (`updatedBy`): the tracker records who last wrote a
	 * task, not who changed its state. A write by someone else after the session's close counts as
	 * theirs, and leaves the close standing.
	 */
	export const refuseDone = async (
		basePath: string,
		task: Task,
		harness: string,
	): Promise<Result<Item[]>> => {
		if (
			task.kind !== "issue" ||
			task.state !== "done" ||
			task.assignee !== harness ||
			task.updatedBy !== CopilotInstructions.actorUri(harness)
		)
			return ok([]);
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
