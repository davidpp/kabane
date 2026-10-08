import { ContextPageOptionsSchema, Planner } from "@cabane/core";
import { flagBool, flagString } from "../args";
import type { Command } from "../context";
import { conciseSuccess, failure, success, usage } from "../output";
import { responseFormat } from "../response-format";

export const context: Command = {
	name: "context",
	summary: "The assembled brief for a task: the read entrypoint for agents",
	usage:
		"kabane context <id> [--no-deref] [--no-subtasks] [--format concise|full] [--sections metadata,description,upstream,position,context,priorWork,discussion] [--cursor <cursor>]",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", context.usage);
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, context.usage);
		const opts = {
			deref: !flagBool(args, "no-deref"),
			includeSubtasks: !flagBool(args, "no-subtasks"),
		};
		if (format.value === "concise") {
			const sections = flagString(args, "sections");
			const parsed = ContextPageOptionsSchema.safeParse({
				...opts,
				sections:
					args.flags.sections === undefined
						? undefined
						: sections === undefined
							? args.flags.sections
							: sections === ""
								? []
								: sections.split(",").map((section) => section.trim()),
				cursor:
					args.flags.cursor === undefined
						? undefined
						: (flagString(args, "cursor") ?? args.flags.cursor),
			});
			if (!parsed.success)
				return usage(
					`Invalid concise context options: ${parsed.error.message.slice(0, 200)}`,
					context.usage,
				);
			const page = await Planner.getContextPage(ctx.store, input, parsed.data);
			return page.ok ? conciseSuccess(page.value) : failure(page.error);
		}
		if (args.flags.sections !== undefined)
			return usage("--sections requires --format concise.", context.usage);
		const brief = await Planner.assembleContext(ctx.store, input, opts);
		if (!brief.ok) return failure(brief.error);
		return success({ taskId: input, markdown: brief.value }, brief.value);
	},
};
