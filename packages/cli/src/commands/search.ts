import { Planner, type TaskState } from "@cabane/core";
import { flagString } from "../args";
import { type Command, resolveScope } from "../context";
import { failure, formatTaskList, success, usage } from "../output";

export const search: Command = {
	name: "search",
	summary: "Full-text search over titles and descriptions",
	usage:
		"cabane search <query> [--state <state>] [--scope <uri>] [--limit <n>]",
	run: async (args, ctx) => {
		const query = args.positionals.join(" ").trim();
		if (!query) return usage("Search query required", search.usage);
		const limitRaw = flagString(args, "limit");
		const tasks = await Planner.searchTasks(ctx.store, query, {
			state: flagString(args, "state") as TaskState | undefined,
			scopeUri: resolveScope(args, ctx),
			limit: limitRaw ? Number(limitRaw) : undefined,
		});
		if (!tasks.ok) return failure(tasks.error);
		return success(
			tasks.value,
			formatTaskList(tasks.value, `No tasks match "${query}".`),
		);
	},
};
