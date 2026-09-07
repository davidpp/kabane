import {
	type ItemKind,
	Planner,
	type TaskPriority,
	type TaskState,
} from "@cabane/core";
import { flagBool, flagString } from "../args";
import { type Command, resolveScope } from "../context";
import { failure, formatTaskList, success } from "../output";

export const list: Command = {
	name: "list",
	summary: "List open tasks (done and cancelled hidden unless --all)",
	usage:
		"cabane list [--state <state>] [--kind task|issue] [--priority <p>] [--assignee <who>] [--scope <uri>] [--tag <tag>] [--all] [--limit <n>]",
	run: async (args, ctx) => {
		const limitRaw = flagString(args, "limit");
		const limit = limitRaw ? Number(limitRaw) : undefined;
		if (limit !== undefined && !(limit > 0))
			return failure("--limit must be a positive number");

		const tasks = await Planner.queryTasks(ctx.home, {
			state: flagString(args, "state") as TaskState | undefined,
			kind: flagString(args, "kind") as ItemKind | undefined,
			priority: flagString(args, "priority") as TaskPriority | undefined,
			assignee: flagString(args, "assignee"),
			scopeUri: resolveScope(args, ctx),
			tag: flagString(args, "tag"),
			includeClosed:
				flagBool(args, "all") || flagString(args, "state") !== undefined,
			limit,
		});
		if (!tasks.ok) return failure(tasks.error);
		return success(tasks.value, formatTaskList(tasks.value));
	},
};
