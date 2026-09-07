import {
	type ItemKind,
	Planner,
	type TaskDraft,
	type TaskPriority,
	type TaskState,
} from "@cabane/core";
import { flagCsv, flagString } from "../args";
import { type Command, resolveScope } from "../context";
import { failure, formatTaskLine, success, usage } from "../output";
import { toDeadline } from "./dates";

export const add: Command = {
	name: "add",
	summary: "Create a task (inbox by default)",
	usage:
		'cabane add "<title>" [--kind task|issue] [--state <state>] [--priority <p>] [--scope <uri>] [--assignee <who>] [--parent <id>] [--description <text>] [--tags a,b] [--due YYYY-MM-DD]',
	run: async (args, ctx) => {
		const title = args.positionals.join(" ").trim();
		if (!title) return usage("Title required", add.usage);

		const parentInput = flagString(args, "parent");
		let parentTaskId: string | undefined;
		if (parentInput) {
			const parent = await Planner.resolveTaskId(ctx.home, parentInput);
			if (!parent.ok) return failure(parent.error);
			parentTaskId = parent.value;
		}

		const draft: TaskDraft = {
			title,
			description: flagString(args, "description"),
			kind: (flagString(args, "kind") as ItemKind | undefined) ?? "task",
			state: (flagString(args, "state") as TaskState | undefined) ?? "inbox",
			priority:
				(flagString(args, "priority") as TaskPriority | undefined) ?? "normal",
			scopeUri: resolveScope(args, ctx),
			assignee: flagString(args, "assignee"),
			parentTaskId,
			tags: flagCsv(args, "tags") ?? [],
			deadline: toDeadline(flagString(args, "due")),
			provenance: {
				source: "human",
				discoveredAt: new Date().toISOString(),
				discoveredBy: ctx.actor,
			},
		};

		const created = await Planner.addTask(ctx.home, draft);
		if (!created.ok) return failure(created.error);
		return success(created.value, `✓ Created ${formatTaskLine(created.value)}`);
	},
};
