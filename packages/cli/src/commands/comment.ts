import { Planner } from "@cabane/core";
import { authorTypeOf } from "../config";
import type { Command } from "../context";
import { failure, success, usage } from "../output";

export const comment: Command = {
	name: "comment",
	summary: "Add a comment (author is the actor; agent actors comment as ai)",
	usage: 'cabane comment <id> "<text>" [--as <actor-uri>]',
	run: async (args, ctx) => {
		const [input, ...rest] = args.positionals;
		const content = rest.join(" ").trim();
		if (!input || !content)
			return usage("Task ID and comment text required", comment.usage);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);

		const created = await Planner.addComment(ctx.store, {
			taskId: resolved.value,
			author: ctx.actor,
			authorType: authorTypeOf(ctx.actor),
			content,
		});
		if (!created.ok) return failure(created.error);
		return success(created.value, `💬 Comment added to ${input}`);
	},
};
