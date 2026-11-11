import { DEFAULT_ENTRY_KIND, Planner } from "@cabane/core";
import { failure, flagString, success, usage } from "@cabane/extension";
import { authorTypeOf } from "../config";
import type { Command } from "../context";

export const comment: Command = {
	name: "comment",
	summary:
		"Add a comment (author is the actor; agent actors comment as ai); --kind keeps it in the brief as that kind",
	usage: 'kabane comment <id> "<text>" [--kind <kind>] [--as <actor-uri>]',
	run: async (args, ctx) => {
		const [input, ...rest] = args.positionals;
		const content = rest.join(" ").trim();
		if (!input || !content)
			return usage("Task ID and comment text required", comment.usage);
		const kind = flagString(args, "kind");
		if ("kind" in args.flags && kind === undefined)
			return usage("--kind needs a value, such as review", comment.usage);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);

		const created = await Planner.addEntry(ctx.store, {
			taskId: resolved.value,
			kind: kind ?? DEFAULT_ENTRY_KIND,
			author: ctx.actor,
			authorType: authorTypeOf(ctx.actor),
			content,
		});
		if (!created.ok) return failure(created.error);
		return success(
			created.value,
			kind === undefined
				? `💬 Comment added to ${input}`
				: `💬 ${kind} added to ${input}`,
		);
	},
};
