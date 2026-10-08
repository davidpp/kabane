import { Planner, type TaskState } from "@cabane/core";
import { flagString } from "../args";
import { type Command, resolveScopeUri } from "../context";
import {
	conciseSuccess,
	failure,
	formatTaskList,
	success,
	usage,
} from "../output";
import { pageOptions, responseFormat } from "../response-format";

export const search: Command = {
	name: "search",
	summary: "Full-text search over titles and descriptions",
	usage:
		"kabane search <query> [--state <state>] [--scope <uri>] [--limit <n>] [--format concise|full] [--cursor <cursor>]",
	run: async (args, ctx) => {
		const query = args.positionals.join(" ").trim();
		if (!query) return usage("Search query required", search.usage);
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, search.usage);
		const opts = {
			state: flagString(args, "state") as TaskState | undefined,
			scopeUri: await resolveScopeUri(args, ctx),
		};
		if (format.value === "concise") {
			const options = pageOptions(args);
			if (!options.ok) return usage(options.error.message, search.usage);
			const page = await Planner.searchTaskPage(
				ctx.store,
				query,
				opts,
				options.value,
			);
			return page.ok ? conciseSuccess(page.value) : failure(page.error);
		}
		const limitRaw = flagString(args, "limit");
		const tasks = await Planner.searchTasks(ctx.store, query, {
			...opts,
			limit: limitRaw ? Number(limitRaw) : undefined,
		});
		if (!tasks.ok) return failure(tasks.error);
		return success(
			tasks.value,
			formatTaskList(tasks.value, `No tasks match "${query}".`),
		);
	},
};
