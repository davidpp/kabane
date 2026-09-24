import { Planner } from "@cabane/core";
import { flagList, flagString } from "../args";
import { authorTypeOf } from "../config";
import type { Command } from "../context";
import { failure, success, usage } from "../output";

/** `--commit`, `--branch`, `--pr`, `--url` are shorthands for `--ref <type>:<value>`. */
const SHORTHANDS = [
	"commit",
	"branch",
	"pr",
	"url",
	"session",
	"file",
] as const;

export const collectRefs = (
	refs: string[],
	shorthand: (key: string) => string[],
): string[] => [
	...refs,
	...SHORTHANDS.flatMap((key) =>
		shorthand(key).map((value) => `${key}:${value}`),
	),
];

export const log: Command = {
	name: "log",
	summary: "Record work done, as URI references",
	usage:
		"kabane log <id> --ref <type:value> [--ref ...] [--commit <sha>] [--branch <name>] [--pr <owner/repo#n>] [--note <text>]",
	run: async (args, ctx) => {
		const input = args.positionals[0];
		if (!input) return usage("Task ID required", log.usage);
		const refs = collectRefs(flagList(args, "ref"), (key) =>
			flagList(args, key),
		);
		if (refs.length === 0)
			return usage(
				"At least one --ref (or --commit/--branch/--pr) required",
				log.usage,
			);
		const resolved = await Planner.resolveTaskId(ctx.store, input);
		if (!resolved.ok) return failure(resolved.error);

		const created = await Planner.addWorkLog(ctx.store, {
			taskId: resolved.value,
			refs: refs.map((uri) => ({ uri })),
			note: flagString(args, "note"),
			addedBy: ctx.actor,
			addedByType: authorTypeOf(ctx.actor),
		});
		if (!created.ok) return failure(created.error);
		return success(
			created.value,
			`📝 Logged ${refs.length} ref${refs.length === 1 ? "" : "s"} on ${input}`,
		);
	},
};
