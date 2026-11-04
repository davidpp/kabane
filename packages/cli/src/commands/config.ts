import { failure, success, usage } from "@cabane/extension";
import { configPath } from "../config";
import { ConfigSettings } from "../config-settings";
import type { Command } from "../context";

const display = (value: unknown): string =>
	value === undefined
		? "default"
		: typeof value === "string"
			? value
			: JSON.stringify(value);

export const config: Command = {
	name: "config",
	summary: "List, get, set or unset device config; show its path",
	usage:
		"kabane config [list|get <key>|set <key> <value>|unset <key>|path] [--json]",
	standalone: true,
	run: async (args, ctx) => {
		const [sub = "list", key, input] = args.positionals;
		const count = { list: 1, path: 1, get: 2, set: 3, unset: 2 };
		if (!Object.hasOwn(count, sub))
			return usage(`Unknown config subcommand: ${sub}`, config.usage);
		const expected = count[sub as keyof typeof count];
		if (
			args.positionals.length !== expected &&
			!(sub === "list" && args.positionals.length === 0)
		)
			return usage(`Wrong arguments for config ${sub}`, config.usage);
		if (Object.keys(args.flags).length > 0)
			return usage(
				"Unknown config option; use -- before a value beginning with --",
				config.usage,
			);
		if (sub === "path")
			return success(configPath(ctx.home), configPath(ctx.home));
		if (sub === "list") {
			const listed = ConfigSettings.list(ctx.home);
			if (!listed.ok) return failure(listed.error);
			return success(
				listed.value,
				listed.value
					.map(
						(row) =>
							`${row.key} = ${row.default ? "default" : display(row.value)} — ${row.description}`,
					)
					.join("\n"),
			);
		}
		if (key === undefined) return usage(`Missing config key`, config.usage);
		if (sub === "get") {
			const value = ConfigSettings.get(ctx.home, key);
			return value.ok
				? success(value.value ?? null, display(value.value))
				: failure(value.error);
		}
		const changed = ConfigSettings.set(ctx.home, key, input);
		return changed.ok
			? success(changed.value, `${key} = ${display(changed.value.value)}`)
			: failure(changed.error);
	},
};
