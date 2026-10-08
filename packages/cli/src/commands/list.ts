import {
	type ItemKind,
	Planner,
	type TaskPriority,
	type TaskState,
} from "@cabane/core";
import { flagBool, flagString } from "../args";
import { type Command, resolveScopeUri } from "../context";
import {
	conciseSuccess,
	failure,
	formatTaskList,
	success,
	usage,
} from "../output";
import { pageOptions, responseFormat } from "../response-format";

export const list: Command = {
	name: "list",
	summary: "List open tasks (done and cancelled hidden unless --all)",
	usage:
		"kabane list [--state <state>] [--kind task|issue] [--priority <p>] [--assignee <who>] [--scope <uri>] [--tag <tag>] [--all] [--limit <n>] [--format concise|full] [--cursor <cursor>]",
	run: async (args, ctx) => {
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, list.usage);
		const query = {
			state: flagString(args, "state") as TaskState | undefined,
			kind: flagString(args, "kind") as ItemKind | undefined,
			priority: flagString(args, "priority") as TaskPriority | undefined,
			assignee: flagString(args, "assignee"),
			scopeUri: await resolveScopeUri(args, ctx),
			tag: flagString(args, "tag"),
			includeClosed:
				flagBool(args, "all") || flagString(args, "state") !== undefined,
		};
		if (format.value === "concise") {
			const options = pageOptions(args);
			if (!options.ok) return usage(options.error.message, list.usage);
			const page = await Planner.queryTaskPage(ctx.store, query, options.value);
			return page.ok ? conciseSuccess(page.value) : failure(page.error);
		}
		const limitRaw = flagString(args, "limit");
		const limit = limitRaw ? Number(limitRaw) : undefined;
		if (limit !== undefined && !(limit > 0))
			return failure("--limit must be a positive number");

		const tasks = await Planner.queryTasks(ctx.store, {
			...query,
			limit,
		});
		if (!tasks.ok) return failure(tasks.error);
		return success(tasks.value, formatTaskList(tasks.value));
	},
};
