import {
	Deadline,
	type ItemKind,
	Planner,
	Runtime,
	taskReceipt,
	type TaskDraft,
	type TaskPriority,
	type TaskState,
} from "@cabane/core";
import { flagCsv, flagString } from "../args";
import { type Command, resolveScopeUri } from "../context";
import {
	conciseSuccess,
	failure,
	formatTaskLine,
	success,
	usage,
} from "../output";
import { responseFormat } from "../response-format";

export const add: Command = {
	name: "add",
	summary: "Create a task (inbox by default)",
	usage:
		'kabane add "<title>" [--kind task|issue] [--state <state>] [--priority <p>] [--scope <uri>] [--assignee <who>] [--parent <id>] [--description <text>] [--tags a,b] [--due YYYY-MM-DD|YYYY-MM-DDTHH:MM] [--format concise|full]',
	run: async (args, ctx) => {
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, add.usage);
		const title = args.positionals.join(" ").trim();
		if (!title) return usage("Title required", add.usage);
		const deadline = Deadline.fromInput(
			flagString(args, "due"),
			Runtime.timezone(),
		);
		if (!deadline.ok) return usage(deadline.error.message, add.usage);

		const parentInput = flagString(args, "parent");
		let parentTaskId: string | undefined;
		if (parentInput) {
			const parent = await Planner.resolveTaskId(ctx.store, parentInput);
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
			scopeUri: await resolveScopeUri(args, ctx),
			assignee: flagString(args, "assignee"),
			parentTaskId,
			tags: flagCsv(args, "tags") ?? [],
			deadline: deadline.value,
			provenance: {
				source: "human",
				discoveredAt: new Date().toISOString(),
				discoveredBy: ctx.actor,
			},
		};

		const created = await Planner.addTask(ctx.store, draft);
		if (!created.ok) return failure(created.error);
		if (format.value === "concise") {
			const receipt = taskReceipt(created.value);
			return receipt.ok
				? conciseSuccess(receipt.value)
				: failure(receipt.error);
		}
		return success(created.value, `✓ Created ${formatTaskLine(created.value)}`);
	},
};
