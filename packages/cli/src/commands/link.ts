import { type LinkType, LinkTypeSchema, Planner } from "@cabane/core";
import { flagString } from "../args";
import type { Command } from "../context";
import { failure, success, usage } from "../output";

export const link: Command = {
	name: "link",
	summary: "Create a typed link between two tasks",
	usage: `kabane link <source-id> <target-id> --type <${LinkTypeSchema.options.join("|")}> [--note <text>]`,
	run: async (args, ctx) => {
		const [sourceInput, targetInput] = args.positionals;
		if (!sourceInput || !targetInput)
			return usage("Source and target task IDs required", link.usage);
		const type = LinkTypeSchema.safeParse(flagString(args, "type"));
		if (!type.success)
			return usage(
				"--type is required and must be a known link type",
				link.usage,
			);

		const source = await Planner.resolveTaskId(ctx.store, sourceInput);
		if (!source.ok) return failure(source.error);
		const target = await Planner.resolveTaskId(ctx.store, targetInput);
		if (!target.ok) return failure(target.error);

		const created = await Planner.addLink(ctx.store, {
			sourceId: source.value,
			targetId: target.value,
			type: type.data as LinkType,
			note: flagString(args, "note"),
		});
		if (!created.ok) return failure(created.error);
		return success(
			created.value,
			`✓ Linked ${sourceInput} → [${type.data}] → ${targetInput}`,
		);
	},
};
