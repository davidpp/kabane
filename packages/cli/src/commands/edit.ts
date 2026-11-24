import {
	Deadline,
	ok,
	type Result,
	type ItemKind,
	Planner,
	Runtime,
	type TaskPriority,
	type TaskState,
	type TaskUpdate,
} from "@kabane/core";
import {
	conciseSuccess,
	failure,
	flagCsv,
	flagString,
	success,
	usage,
} from "@kabane/extension";
import type { Command } from "../context";
import { formatTaskLine } from "../output";
import { responseFormat } from "../response-format";

const nothingToChange = (update: TaskUpdate): boolean =>
	Object.values(update).every((v) => v === undefined);

/** Setting in_progress claims the task: who holds the claim afterwards. */
const claimOf = async (
	store: string,
	id: string,
	update: TaskUpdate,
	actor: string,
): Promise<Result<{ claimedBy?: string | null; claimHeld?: boolean }>> => {
	if (update.state !== "in_progress") return ok({});
	const holder = await Planner.claimHolder(store, id);
	return holder.ok
		? ok({ claimedBy: holder.value, claimHeld: holder.value === actor })
		: holder;
};

const claimLine = (holder: string | null, actor: string): string =>
	holder === actor
		? `Claimed by you (${holder})`
		: `Claim held by ${holder ?? "nobody"}, not you (${actor}): leave it`;

export const edit: Command = {
	name: "edit",
	summary: "Update fields on a task",
	usage:
		"kabane edit <id> [--title <t>] [--description <d>] [--state <s>] [--priority <p>] [--kind task|issue|job] [--assignee <who>|none] [--scope <uri>] [--parent <id>|none] [--tags a,b] [--due YYYY-MM-DD|YYYY-MM-DDTHH:MM] [--format concise|full]",
	run: async (args, ctx) => {
		const format = responseFormat(args);
		if (!format.ok) return usage(format.error.message, edit.usage);
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

		if (format.value === "concise") {
			const receipt = await Planner.updateTaskReceipt(
				ctx.store,
				resolved.value,
				update,
			);
			if (!receipt.ok) return failure(receipt.error);
			return conciseSuccess(receipt.value);
		}
		const updated = await Planner.updateTask(ctx.store, resolved.value, update);
		if (!updated.ok) return failure(updated.error);
		if (!updated.value) return failure(`No task found: ${input}`);
		const claim = await claimOf(ctx.store, resolved.value, update, ctx.actor);
		if (!claim.ok) return failure(claim.error);
		const lines = [`✏️  Updated ${formatTaskLine(updated.value)}`];
		if (claim.value.claimedBy !== undefined)
			lines.push(claimLine(claim.value.claimedBy, ctx.actor));
		return success({ ...updated.value, ...claim.value }, lines.join("\n"));
	},
};
