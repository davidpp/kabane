import { Planner } from "@cabane/core";
import type { Command } from "../context";
import {
	failure,
	formatComments,
	formatLinks,
	formatTaskDetail,
	formatWorkLogs,
	success,
	usage,
} from "../output";

export const show: Command = {
	name: "show",
	summary: "Show a task with its links, comments, and work logs",
	usage: "cabane show <id>",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", show.usage);

		const task = await Planner.getTask(ctx.store, input);
		if (!task.ok) return failure(task.error);
		if (!task.value) return failure(`No task found: ${input}`);
		const id = task.value.id;

		const [links, comments, logs] = await Promise.all([
			Planner.getLinksForTask(ctx.store, id),
			Planner.getComments(ctx.store, id),
			Planner.getWorkLogs(ctx.store, id),
		]);
		if (!links.ok) return failure(links.error);
		if (!comments.ok) return failure(comments.error);
		if (!logs.ok) return failure(logs.error);

		const sections = [formatTaskDetail(task.value)];
		if (links.value.length > 0)
			sections.push(`\nLinks:\n${formatLinks(id, links.value)}`);
		if (comments.value.length > 0)
			sections.push(`\nComments:\n${formatComments(comments.value)}`);
		if (logs.value.length > 0)
			sections.push(`\nWork log:\n${formatWorkLogs(logs.value)}`);

		return success(
			{
				task: task.value,
				links: links.value,
				comments: comments.value,
				workLogs: logs.value,
			},
			sections.join("\n"),
		);
	},
};
