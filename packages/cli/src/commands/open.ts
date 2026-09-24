import { Launcher } from "@cabane/board";
import { Planner } from "@cabane/core";
import type { Command } from "../context";
import { failure, success } from "../output";

/**
 * The high-frequency half of linked issues gets the short name. Creating a link
 * is something an agent does once; opening one is something the human does all
 * day, and `kabane open JCAB-12` is what that should cost.
 */
export const open: Command = {
	name: "open",
	summary: "Open a task's linked issue in its app or the browser",
	usage: "kabane open <task-id>",
	run: async (args, ctx) => {
		const [input] = args.positionals;
		if (!input) return failure("Task ID required");

		const taskId = await Planner.resolveTaskId(ctx.store, input);
		if (!taskId.ok) return failure(taskId.error);

		const links = await Planner.getUpstreamLinksForTask(
			ctx.store,
			taskId.value,
		);
		if (!links.ok) return failure(links.error);

		// Several links open the first, as the board's `O` does. `kabane show` lists them all.
		const link = links.value[0];
		if (!link) return failure(`${input} has no linked issue`);

		const target = {
			provider: link.provider,
			identifier: link.identifier,
			url: link.url,
		};
		const opened = await Launcher.open(target);
		if (!opened.ok) return failure(opened.error);

		const name = Launcher.label(target);
		return success(
			{ ...link, opened: opened.value },
			opened.value === "clipboard"
				? `no opener · ${name} copied`
				: `opening ${name} in ${link.provider}`,
		);
	},
};
