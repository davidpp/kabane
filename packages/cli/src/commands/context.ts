import { Planner } from "@cabane/core";
import { flagBool } from "../args";
import type { Command } from "../context";
import { failure, success, usage } from "../output";

export const context: Command = {
	name: "context",
	summary: "The assembled brief for a task: the read entrypoint for agents",
	usage: "kabane context <id> [--no-deref] [--no-subtasks]",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", context.usage);
		const brief = await Planner.assembleContext(ctx.store, input, {
			deref: !flagBool(args, "no-deref"),
			includeSubtasks: !flagBool(args, "no-subtasks"),
		});
		if (!brief.ok) return failure(brief.error);
		return success({ taskId: input, markdown: brief.value }, brief.value);
	},
};
