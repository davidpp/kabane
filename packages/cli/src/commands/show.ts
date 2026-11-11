import { ok, Planner, type Result, Runtime } from "@cabane/core";
import { failure, success, usage } from "@cabane/extension";
import type { Command } from "../context";
import {
	formatComments,
	formatLinks,
	formatTaskDetail,
	formatWorkLogs,
} from "../output";
import { liftedKinds, sectionsOf } from "../sections";

/**
 * Each registered module section's markdown by name, a lifted kind's `<kind>.latest`
 * included, the empty ones left out: core's selected-section renderer, one section at a
 * time, every bounded chunk consumed.
 */
const moduleSections = async (
	basePath: string,
	id: string,
): Promise<Result<Record<string, string>>> => {
	const names = Runtime.modules()
		.flatMap(sectionsOf)
		.map((section) => section.name);
	const sections: Record<string, string> = {};
	for (const name of names) {
		let markdown = "";
		let cursor: string | undefined;
		do {
			const page = await Planner.getContextPage(basePath, id, {
				sections: [name],
				cursor,
			});
			if (!page.ok) return page;
			markdown += page.value.markdown;
			cursor = page.value.nextCursor;
		} while (cursor !== undefined);
		if (markdown) sections[name] = markdown;
	}
	return ok(sections);
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
			Planner.getEntries(ctx.store, id),
			Planner.getWorkLogs(ctx.store, id),
			moduleSections(ctx.store, id),
		]);
		if (!links.ok) return failure(links.error);
		if (!comments.ok) return failure(comments.error);
		if (!logs.ok) return failure(logs.error);
		if (!modules.ok) return failure(modules.error);

		// A lifted kind's entries print as its section below, not a second time here.
		const lifted = new Set(Runtime.modules().flatMap(liftedKinds));
		const listed = comments.value.filter((entry) => !lifted.has(entry.kind));
		const sections = [formatTaskDetail(task.value)];
		if (links.value.length > 0)
			sections.push(`\nLinks:\n${formatLinks(id, links.value)}`);
		if (listed.length > 0)
			sections.push(`\nComments:\n${formatComments(listed)}`);
		if (logs.value.length > 0)
			sections.push(`\nWork log:\n${formatWorkLogs(logs.value)}`);

		for (const markdown of Object.values(modules.value))
			sections.push(`\n${markdown}`);

		return success(
			{
				task: task.value,
				links: links.value,
				comments: comments.value,
				workLogs: logs.value,
				sections: modules.value,
			},
			sections.join("\n"),
		);
	},
};
