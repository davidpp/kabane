import {
	Deadline,
	type ItemKind,
	Planner,
	Runtime,
	type TaskPriority,
	type TaskState,
	type TaskUpdate,
} from "@cabane/core";
import { flagCsv, flagString } from "../args";
import type { Command } from "../context";
import { failure, formatTaskLine, success, usage } from "../output";

const nothingToChange = (update: TaskUpdate): boolean =>
	Object.values(update).every((v) => v === undefined);

export const edit: Command = {
	name: "edit",
	summary: "Update fields on a task",
	usage:
		"cabane edit <id> [--title <t>] [--description <d>] [--state <s>] [--priority <p>] [--kind task|issue] [--assignee <who>|none] [--scope <uri>] [--parent <id>|none] [--tags a,b] [--due YYYY-MM-DD|YYYY-MM-DDTHH:MM]",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", edit.usage);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);

		const parentInput = flagString(args, "parent");
		let parentTaskId: string | undefined;
		if (parentInput && parentInput !== "none") {
			const parent = await Planner.resolveTaskId(ctx.store, parentInput);
			if (!parent.ok) return failure(parent.error);
			parentTaskId = parent.value;
		}
		const assignee = flagString(args, "assignee");
		const deadline = Deadline.fromInput(
			flagString(args, "due"),
			Runtime.timezone(),
		);
		if (!deadline.ok) return usage(deadline.error.message, edit.usage);

		const update: TaskUpdate = {
			title: flagString(args, "title"),
			description: flagString(args, "description"),
			state: flagString(args, "state") as TaskState | undefined,
			priority: flagString(args, "priority") as TaskPriority | undefined,
			kind: flagString(args, "kind") as ItemKind | undefined,
			assignee: assignee === "none" ? "" : assignee,
			scopeUri: flagString(args, "scope"),
			parentTaskId: parentInput === "none" ? null : parentTaskId,
			tags: flagCsv(args, "tags"),
			deadline: deadline.value,
		};
		if (nothingToChange(update)) return usage("Nothing to change", edit.usage);

		const updated = await Planner.updateTask(ctx.store, resolved.value, update);
		if (!updated.ok) return failure(updated.error);
		if (!updated.value) return failure(`No task found: ${input}`);
		return success(
			updated.value,
			`✏️  Updated ${formatTaskLine(updated.value)}`,
		);
	},
};
