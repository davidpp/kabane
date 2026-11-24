import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Plan, Planner, trySync } from "@kabane/core";
import { failure, flagString, success, usage } from "@kabane/extension";
import { authorTypeOf } from "../config";
import { type Command, resolveScopeUri } from "../context";

export const apply: Command = {
	name: "apply",
	summary: "File a plan's threads and links; applying it again creates nothing",
	usage: "kabane apply <file.json> --key <plan key> [--scope <uri>]",
	run: async (args, ctx) => {
		const [file] = args.positionals;
		const key = flagString(args, "key");
		if (!file || args.positionals.length !== 1)
			return usage("Supply one plan file", apply.usage);
		if (!key) return usage("Supply the plan's key with --key", apply.usage);
		const plan = trySync(
			// Shape-checked by applyPlan, which every surface writes through.
			() => JSON.parse(readFileSync(resolve(ctx.cwd, file), "utf8")) as Plan,
		);
		if (!plan.ok) return failure(plan.error);
		const applied = await Planner.applyPlan(ctx.store, plan.value, {
			key,
			scopeUri: await resolveScopeUri(args, ctx),
			author: ctx.actor,
			source: authorTypeOf(ctx.actor),
		});
		if (!applied.ok) return failure(applied.error);
		const { threads, links } = applied.value;
		const made = threads.filter((thread) => thread.created).length;
		return success(
			applied.value,
			[
				`Plan ${key}: ${made} created, ${threads.length - made} already there; links ${links.created} created, ${links.existing} already there`,
				...threads.map(
					(thread) =>
						`${thread.created ? "+" : "="} ${thread.shortId ?? ""} ${thread.id}`,
				),
			].join("\n"),
		);
	},
};
