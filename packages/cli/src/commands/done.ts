import { Planner } from "@cabane/core";
import type { Command } from "../context";
import {
	conciseSuccess,
	failure,
	formatTaskLine,
	success,
	usage,
} from "../output";
import { responseFormat } from "../response-format";

export const done: Command = {
	name: "done",
	summary: "Mark a task done",
	usage: "kabane done <id> [--format concise|full]",
	run: async (args, ctx) => {
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, done.usage);
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", done.usage);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);
		if (format.value === "concise") {
			const receipt = await Planner.updateTaskReceipt(
				ctx.store,
				resolved.value,
				{ state: "done" },
			);
			return receipt.ok
				? conciseSuccess(receipt.value)
				: failure(receipt.error);
		}
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
