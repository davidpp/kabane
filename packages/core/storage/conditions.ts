import { err, map, NotFoundError, ok, type Result } from "../result";
import type { TaskState } from "../schemas";
import { Planner as Links } from "./task-links";
import { Planner as Tasks } from "./tasks";

const requireTask = async (basePath: string, id: string) => {
	const task = await Tasks.getTask(basePath, id);
	if (!task.ok) return task;
	return task.value
		? ok(task.value)
		: err(new NotFoundError(`No task found: ${id}`));
};

export namespace Planner {
	export const matchingState = async (
		basePath: string,
		id: string,
		states: readonly TaskState[],
	): Promise<Result<TaskState | null>> =>
		map(await requireTask(basePath, id), ({ state }) =>
			states.includes(state) ? state : null,
		);

	export const isReady = async (
		basePath: string,
		id: string,
	): Promise<Result<boolean>> => {
		const task = await requireTask(basePath, id);
		if (!task.ok) return task;
		const taskId = task.value.id;
		const links = await Links.getLinksForTask(basePath, taskId);
		if (!links.ok) return links;
		const ids = new Set<string>();
		for (const link of links.value) {
			if (link.type === "blocks" && link.targetId === taskId)
				ids.add(link.sourceId);
			if (
				(link.type === "blocked_by" || link.type === "follows") &&
				link.sourceId === taskId
			)
				ids.add(link.targetId);
		}
		return map(await Tasks.getTasks(basePath, [...ids]), (blockers) =>
			blockers.every(({ state }) => state === "done" || state === "cancelled"),
		);
	};
}
