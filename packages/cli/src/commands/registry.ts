import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { trySync } from "@kabane/core";
import { failure, success, usage } from "@kabane/extension";
import { Registry } from "@kabane/registry";
import { type Command, resolveScopeUri } from "../context";

export const registry: Command = {
	name: "registry",
	summary: "Publish or list a scope's vocabulary and classify its threads",
	usage:
		"kabane registry list | publish <file.json> [--scope <scope>] | set <id> <key> <value> | clear <id> <key>",
	run: async (args, ctx) => {
		const [action, ...rest] = args.positionals;
		const [first, key, value] = rest;
		if (
			first &&
			key &&
			((action === "set" && rest.length === 3 && value) ||
				(action === "clear" && rest.length === 2))
		) {
			const result = await Registry.set(ctx.store, first, key, value ?? null);
			return result.ok
				? success(result.value, JSON.stringify(result.value))
				: failure(result.error);
		}
		const scope = await resolveScopeUri(args, ctx);
		if (!scope)
			return usage("Supply an exact scope with --scope", registry.usage);
		if (action === "list" && rest.length === 0) {
			const result = await Registry.list(ctx.store, scope);
			return result.ok
				? success(result.value, JSON.stringify(result.value, null, 2))
				: failure(result.error);
		}
		if (action === "publish" && first && rest.length === 1) {
			const input = trySync((): unknown =>
				JSON.parse(readFileSync(resolve(ctx.cwd, first), "utf8")),
			);
			if (!input.ok) return failure(input.error);
			const result = await Registry.publish(ctx.store, scope, input.value);
			return result.ok
				? success(result.value, JSON.stringify(result.value, null, 2))
				: failure(result.error);
		}
		return usage("Choose a registry operation", registry.usage);
	},
};
