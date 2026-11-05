import { ok, Planner, type Result, Runtime } from "@cabane/core";
import { failure, success, usage } from "@cabane/extension";
import type { Command } from "../context";
import {
	formatComments,
	formatLinks,
	formatTaskDetail,
	formatWorkLogs,
} from "../output";

/** Use core's selected-section renderer and consume every bounded chunk. */
const moduleMarkdown = async (
	basePath: string,
	id: string,
): Promise<Result<string>> => {
	const sections = Runtime.modules().flatMap((module) =>
		(module.contextSections ?? []).map((section) => section.name),
	);
	if (!sections.length) return ok("");
	let markdown = "";
	let cursor: string | undefined;
	do {
		const page = await Planner.getContextPage(basePath, id, {
			sections,
			cursor,
		});
		if (!page.ok) return page;
		markdown += page.value.markdown;
		cursor = page.value.nextCursor;
	} while (cursor !== undefined);
	return ok(markdown);
};

export const show: Command = {
	name: "show",
	summary: "Show a task with its links, comments, and work logs",
	usage: "kabane show <id>",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", show.usage);

		const task = await Planner.getTask(ctx.store, input);
		if (!task.ok) return failure(task.error);
		if (!task.value) return failure(`No task found: ${input}`);
		const id = task.value.id;

		const [links, comments, logs, modules] = await Promise.all([
			Planner.getLinksForTask(ctx.store, id),
			Planner.getComments(ctx.store, id),
			Planner.getWorkLogs(ctx.store, id),
			moduleMarkdown(ctx.store, id),
		]);
		if (!links.ok) return failure(links.error);
		if (!comments.ok) return failure(comments.error);
		if (!logs.ok) return failure(logs.error);
		if (!modules.ok) return failure(modules.error);

		const sections = [formatTaskDetail(task.value)];
		if (links.value.length > 0)
			sections.push(`\nLinks:\n${formatLinks(id, links.value)}`);
		if (comments.value.length > 0)
			sections.push(`\nComments:\n${formatComments(comments.value)}`);
		if (logs.value.length > 0)
			sections.push(`\nWork log:\n${formatWorkLogs(logs.value)}`);

		if (modules.value) sections.push(`\n${modules.value}`);

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
