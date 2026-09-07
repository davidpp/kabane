/**
 * Planner Storage — Composed Implementation View
 *
 * Folds cached upstream links, a root task, its direct subtasks, and existing
 * awaiting-input session data. It performs no provider or outbound I/O.
 */

import { err, ok, type Result } from "../result";
import type {
	ImplementationResult,
	ImplementationRollup,
	ImplementationSelector,
	ImplementationView,
	Task,
} from "../schemas";
import { ImplementationSelectorSchema } from "../schemas";
import type { NeedsInputItem } from "./sessions";
import { Planner as PlannerSessions } from "./sessions";
import { Planner as PlannerTasks } from "./tasks";
import { Planner as PlannerUpstreamLinks } from "./upstream-links";

const rollupFor = (
	rootTaskId: string,
	subtasks: Task[],
	needsInput: NeedsInputItem[],
): ImplementationRollup => {
	const includedTaskIds = new Set([
		rootTaskId,
		...subtasks.map((task) => task.id),
	]);
	const awaitingSessionIds = new Set(
		needsInput
			.filter((item) => includedTaskIds.has(item.session.taskId))
			.map((item) => item.session.id),
	);

	return {
		total: subtasks.length,
		done: subtasks.filter((task) => task.state === "done").length,
		active: subtasks.filter((task) => task.state === "in_progress").length,
		needsInput: awaitingSessionIds.size,
	};
};

const assembleView = async (
	basePath: string,
	rootTask: Task,
	needsInput: NeedsInputItem[],
): Promise<Result<ImplementationView>> => {
	const [linksResult, subtasksResult] = await Promise.all([
		PlannerUpstreamLinks.getUpstreamLinksForTask(basePath, rootTask.id),
		PlannerTasks.queryTasks(basePath, {
			parentTaskId: rootTask.id,
			includeClosed: true,
			includeDeferred: true,
			limit: Number.MAX_SAFE_INTEGER,
		}),
	]);
	if (!linksResult.ok) return linksResult;
	if (!subtasksResult.ok) return subtasksResult;

	return ok({
		rootTask,
		upstreamLinks: linksResult.value,
		subtasks: subtasksResult.value,
		rollup: rollupFor(rootTask.id, subtasksResult.value, needsInput),
	});
};

const resolveRoots = async (
	basePath: string,
	selector: ImplementationSelector,
): Promise<Result<Task[]>> => {
	if (selector.taskId) {
		const idResult = await PlannerTasks.resolveTaskId(
			basePath,
			selector.taskId,
		);
		if (!idResult.ok) return idResult;
		const taskResult = await PlannerTasks.getTask(basePath, idResult.value);
		if (!taskResult.ok) return taskResult;
		if (!taskResult.value) {
			return err(new Error(`Task not found: ${selector.taskId}`));
		}
		return ok([taskResult.value]);
	}
	if (!selector.provider || !selector.externalId) {
		return err(new Error("Invalid external implementation selector"));
	}

	const linksResult = await PlannerUpstreamLinks.getUpstreamLinksByExternalRef(
		basePath,
		selector.provider,
		selector.externalId,
	);
	if (!linksResult.ok) return linksResult;

	const taskIds = [...new Set(linksResult.value.map((link) => link.taskId))];
	if (taskIds.length === 0) return ok([]);

	const tasksResult = await PlannerTasks.getTasks(basePath, taskIds);
	if (!tasksResult.ok) return tasksResult;
	const tasksById = new Map(tasksResult.value.map((task) => [task.id, task]));
	return ok(
		taskIds
			.map((taskId) => tasksById.get(taskId))
			.filter((task): task is Task => task !== undefined),
	);
};

export namespace Planner {
	/** Return one local implementation view per root matched by the selector. */
	export const implementation = async (
		basePath: string,
		selector: ImplementationSelector,
	): Promise<Result<ImplementationResult>> => {
		const selectorResult = ImplementationSelectorSchema.safeParse(selector);
		if (!selectorResult.success) {
			return err(
				new Error(
					`Invalid implementation selector: ${selectorResult.error.message}`,
				),
			);
		}

		const rootsResult = await resolveRoots(basePath, selectorResult.data);
		if (!rootsResult.ok) return rootsResult;
		if (rootsResult.value.length === 0) return ok({ implementations: [] });

		const needsInputResult = await PlannerSessions.getNeedsInput(basePath);
		if (!needsInputResult.ok) return needsInputResult;

		const viewResults = await Promise.all(
			rootsResult.value.map((task) =>
				assembleView(basePath, task, needsInputResult.value),
			),
		);
		const implementations: ImplementationView[] = [];
		for (const result of viewResults) {
			if (!result.ok) return result;
			implementations.push(result.value);
		}

		return ok({ implementations });
	};
}
