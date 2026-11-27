import {
	CustomAttributeKeySchema,
	ItemKindSchema,
	Planner,
	type TaskPriority,
	type TaskState,
} from "@kabane/core";
import {
	conciseSuccess,
	failure,
	flagBool,
	flagString,
	success,
	usage,
} from "@kabane/extension";
import { type Command, resolveScopeUri } from "../context";
import { formatTaskList } from "../output";
import { pageOptions, responseFormat } from "../response-format";

export const list: Command = {
	name: "list",
	summary: "List open tasks (done and cancelled hidden unless --all)",
	usage:
		"kabane list [--state <state>] [--kind <kind>] [--priority <p>] [--assignee <who>] [--scope <uri>] [--tag <tag>] [--attribute <key>] [--all] [--limit <n>] [--format concise|full] [--cursor <cursor>]",
	run: async (args, ctx) => {
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, list.usage);
		const attribute = flagString(args, "attribute");
		if (
			args.flags.attribute !== undefined &&
			(!CustomAttributeKeySchema.safeParse(attribute).success ||
				format.value !== "concise")
		)
			return usage(
				"--attribute requires a declared key and --format concise",
				list.usage,
			);
		const kind = ItemKindSchema.optional().safeParse(flagString(args, "kind"));
		if (!kind.success)
			return usage(
				`--kind ${kind.error.issues.map((issue) => issue.message).join("; ")}`,
				list.usage,
			);
		const query = {
			state: flagString(args, "state") as TaskState | undefined,
			kind: kind.data,
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
			const page = await Planner.queryTaskPage(ctx.store, query, {
				...options.value,
				attribute,
			});
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
