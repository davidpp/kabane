import { Planner } from "@cabane/core";
import type { Command } from "../context";
import { failure, formatTaskLine, success, usage } from "../output";

export const done: Command = {
	name: "done",
	summary: "Mark a task done",
	usage: "kabane done <id>",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", done.usage);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);
		const updated = await Planner.updateTask(ctx.store, resolved.value, {
			state: "done",
		});
		if (!updated.ok) return failure(updated.error);
		if (!updated.value) return failure(`No task found: ${input}`);
		return success(
			updated.value,
			`✅ Completed ${formatTaskLine(updated.value)}`,
		);
	},
};
