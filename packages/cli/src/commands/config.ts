import { err, ok, type Result } from "@cabane/core";
import {
	failure,
	flagString,
	type Outcome,
	type ParsedArgs,
	success,
	usage,
} from "@cabane/extension";
import { configPath } from "../config";
import { ConfigSettings } from "../config-settings";
import type { Command } from "../context";
import { Extensions } from "../extensions";

const display = (value: unknown): string =>
	value === undefined || value === null
		? "default"
		: typeof value === "string"
			? value
			: JSON.stringify(value);

// A leaf's value and the layer it came from: `bun test (scope: your settings for scope …)`.
const leafText = (leaf: {
	value: unknown;
	layer: string;
	from?: string;
}): string =>
	leaf.value === null
		? "default"
		: `${display(leaf.value)} (${leaf.from === undefined ? leaf.layer : `${leaf.layer}: ${leaf.from}`})`;

// `--layer`, the layer a write targets; `--scope`, whose user settings to read or write; and
// `--layers`, which has `get` name the layer of every leaf instead of printing the bare value.
const FLAGS: ReadonlySet<string> = new Set(["layer", "scope", "layers"]);
const COUNT = { list: 1, path: 1, get: 2, set: 3, unset: 2 };

type Request = {
	sub: keyof typeof COUNT;
	key?: string;
	input?: string;
	target: ConfigSettings.Target;
	scope?: string;
	layers: boolean;
};

const USAGE = [
	"kabane config [list|get <key> [--layers]|set <key> <value>|unset <key>|path] [--layer user|scope|project] [--scope <scope>] [--json]",
	"",
	"A setting resolves lowest first: its default, your config (user), the project's",
	".kabane/<namespace>.json (project), your settings for the project's scope (scope), then",
	"a command's own flags. set and unset write the user layer unless --layer names another;",
	"scope is the project here, or --scope. Device keys (sync, db, identities) are user only.",
	"get --layers prints every leaf under the key with the layer it came from.",
].join("\n");

const isSub = (sub: string): sub is Request["sub"] => Object.hasOwn(COUNT, sub);

/** The subcommand, its arguments and the layer it targets, or the usage error to print. */
const requestOf = (args: ParsedArgs): Result<Request, Outcome> => {
	const [sub = "list", key, input] = args.positionals;
	if (!isSub(sub))
		return err(usage(`Unknown config subcommand: ${sub}`, USAGE));
	// Before the count: a value beginning with -- parses as a flag and leaves a positional short.
	const flag = Object.keys(args.flags).find((name) => !FLAGS.has(name));
	if (flag !== undefined)
		return err(
			usage(
				`Unknown config option --${flag}; for a value beginning with --, put -- before it: kabane config set <key> -- <value>`,
				USAGE,
			),
		);
	if (
		args.positionals.length !== COUNT[sub] &&
		!(sub === "list" && args.positionals.length === 0)
	)
		return err(usage(`Wrong arguments for config ${sub}`, USAGE));
	const layer = flagString(args, "layer");
	const scope = flagString(args, "scope");
	if ("layer" in args.flags && sub !== "set" && sub !== "unset")
		return err(usage("--layer applies to set and unset", USAGE));
	// A bare --layer would otherwise fall back to user and change every project's setting.
	if ("layer" in args.flags && layer === undefined)
		return err(
			usage(`--layer takes one of ${ConfigSettings.TARGETS.join(", ")}`, USAGE),
		);
	if ("layers" in args.flags && sub !== "get")
		return err(usage("--layers applies to get", USAGE));
	if ("layers" in args.flags && args.flags.layers !== true)
		return err(
			usage("--layers takes no value: kabane config get <key> --layers", USAGE),
		);
	if ("scope" in args.flags && scope === undefined)
		return err(usage("--scope takes a scope URI or id", USAGE));
	// --scope alone names the layer a write goes to.
	const target = layer ?? (scope === undefined ? "user" : "scope");
	if (!ConfigSettings.isTarget(target))
		return err(
			usage(`--layer takes one of ${ConfigSettings.TARGETS.join(", ")}`, USAGE),
		);
	return ok({
		sub,
		target,
		layers: args.flags.layers === true,
		...(key === undefined ? {} : { key }),
		...(input === undefined ? {} : { input }),
		...(scope === undefined ? {} : { scope }),
	});
};

const list = async (home: string, where: ConfigSettings.Where) => {
	const listed = await ConfigSettings.list(home, where);
	if (!listed.ok) return failure(listed.error);
	return success(
		listed.value,
		listed.value
			.map(
				(row) =>
					`${row.key} = ${row.default ? "default" : `${display(row.value)} (${row.layer})`} — ${row.description}`,
			)
			.join("\n"),
	);
};

// The bare value, as `get` always printed it; with --layers, a leaf's value and layer, or a line
// per leaf under a group.
const get = async (
	home: string,
	where: ConfigSettings.Where,
	key: string,
	layers: boolean,
) => {
	const got = await ConfigSettings.get(home, where, key);
	if (!got.ok) return failure(got.error);
	if (!layers) return success(got.value.value, display(got.value.value));
	const leaves = Object.entries(got.value.leaves);
	const [only] = leaves;
	return success(
		got.value,
		leaves.length === 1 && only?.[0] === key
			? leafText(only[1])
			: leaves.map(([name, leaf]) => `${name} = ${leafText(leaf)}`).join("\n"),
	);
};

export const config: Command = {
	name: "config",
	summary:
		"List, get, set or unset config and settings, with the layer each comes from; show its path",
	usage: USAGE,
	standalone: true,
	run: async (args, ctx) => {
		const request = requestOf(args);
		if (!request.ok) return request.error;
		const { sub, key, input, target, scope, layers } = request.value;
		if (sub === "path")
			return success(configPath(ctx.home), configPath(ctx.home));
		const where = await ConfigSettings.locate(ctx.home, ctx.cwd, scope);
		if (!where.ok) return failure(where.error);
		if (sub === "list") return list(ctx.home, where.value);
		if (key === undefined) return usage(`Missing config key`, USAGE);
		if (sub === "get") return get(ctx.home, where.value, key, layers);
		const changed = await ConfigSettings.set(
			ctx.home,
			where.value,
			key,
			sub === "set" ? input : undefined,
			target,
		);
		if (!changed.ok) return failure(changed.error);
		for (const name of changed.value.ignored ?? [])
			console.error(Extensions.ignoredWarning(name, ctx.home));
		return success(
			changed.value,
			`${key} = ${display(changed.value.value)}${target === "user" ? "" : ` (${target})`}`,
		);
	},
};
