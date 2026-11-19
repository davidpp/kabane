import type { Result, Task } from "@cabane/core";
import type { Host } from "@cabane/extension";
import { z } from "zod";
import { ok, err } from "./result";
import { actorUri } from "./session-identity";

const ItemSchema = z.object({
	id: z.string(),
	taskId: z.string(),
	text: z.string(),
	done: z.boolean(),
	doneAt: z.string().optional(),
	doneBy: z.string().optional(),
	removedAt: z.string().optional(),
	rank: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	updatedBy: z.string(),
	version: z.number(),
	visibility: z.string(),
	handle: z.string(),
	ordinal: z.number(),
	shortId: z.string().optional(),
});

const ItemsSchema = z.array(ItemSchema);

export namespace Checklists {
	export type Item = z.output<typeof ItemSchema>;

	/** Read through the registered checklist tool; a host without that module has no items. */
	export const of = async (
		host: Host,
		taskId: string,
	): Promise<Result<Item[]>> => {
		const result = await host.record.call("kabane_checklist", { id: taskId });
		if (!result.ok)
			return result.error.message === "Unknown tool: kabane_checklist"
				? ok([])
				: result;
		const parsed = ItemsSchema.safeParse(result.value);
		return parsed.success ? ok(parsed.data) : err(parsed.error);
	};

	/** A stable mark of each task's ticked and total items; read failure leaves the other marks. */
	export const progress = async (
		host: Host,
		taskIds: readonly string[],
	): Promise<string> => {
		const marks: string[] = [];
		for (const id of [...new Set(taskIds)].sort()) {
			const items = await of(host, id);
			if (!items.ok) return "";
			if (items.value.length > 0)
				marks.push(
					`${id}:${items.value.filter((item) => item.done).length}/${items.value.length}`,
				);
		}
		return marks.join(",");
	};

	export const open = (items: readonly Item[]): Item[] =>
		items.filter((item) => !item.done);

	/**
	 * The ticked items, in list order, that a checkpoint has not named yet: those not `seen` by the
	 * last one, which recorded what it read; else, with no such record, those ticked after `at`.
	 */
	export const tickedSince = (
		items: readonly Item[],
		since: { seen: readonly string[] } | { at: string },
	): Item[] =>
		items.filter((item) =>
			"seen" in since
				? item.done && !since.seen.includes(item.id)
				: item.doneAt !== undefined && item.doneAt > since.at,
		);

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
		host: Host,
		task: Task,
		harness: string,
	): Promise<Result<Item[]>> => {
		if (
			task.kind !== "issue" ||
			task.state !== "done" ||
			task.assignee !== harness ||
			task.updatedBy !== actorUri(harness)
		)
			return ok([]);
		const items = await of(host, task.id);
		if (!items.ok) return items;
		const left = open(items.value);
		if (left.length === 0) return ok([]);
		const reopened = await host.record.edit({
			id: task.id,
			state: "in_progress",
		});
		return reopened.ok ? ok(left) : reopened;
	};
}
