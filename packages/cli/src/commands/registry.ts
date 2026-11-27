import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Result, trySync } from "@kabane/core";
import { failure, success, usage } from "@kabane/extension";
import { Registry } from "@kabane/registry";
import { type Command, resolveScopeUri } from "../context";

/** The operations on one scope's declarations; undefined when the arguments name none. */
const scoped = (
	action: string | undefined,
	rest: string[],
	scope: string,
	ctx: { store: string; cwd: string },
): Promise<Result<unknown>> | undefined => {
	const [file] = rest;
	if (action === "list" && rest.length === 0)
		return Registry.list(ctx.store, scope);
	if (action === "kinds" && rest.length === 0)
		return Registry.kinds(ctx.store, scope);
	if (action !== "publish" || !file || rest.length !== 1) return undefined;
	const input = trySync((): unknown =>
		JSON.parse(readFileSync(resolve(ctx.cwd, file), "utf8")),
	);
	return input.ok
		? Registry.publish(ctx.store, scope, input.value)
		: Promise.resolve(input);
};

export const registry: Command = {
	name: "registry",
	summary:
		"Publish or list a scope's vocabulary and thread kinds, and classify its threads",
	usage:
		"kabane registry list | kinds | publish <file.json> [--scope <scope>] | set <id> <key> <value> | clear <id> <key>",
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
		const result = await scoped(action, rest, scope, ctx);
		if (!result) return usage("Choose a registry operation", registry.usage);
		return result.ok
			? success(result.value, JSON.stringify(result.value, null, 2))
			: failure(result.error);
	},
};
