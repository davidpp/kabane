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

// A leaf's value and the layer it came from: `bun test (local: ~/.kabane/projects/…/loop.json)`.
const leafText = (leaf: {
	value: unknown;
	layer: string;
	from?: string;
}): string =>
	leaf.value === null
		? "default"
		: `${display(leaf.value)} (${leaf.from === undefined ? leaf.layer : `${leaf.layer}: ${leaf.from}`})`;

// `--layer`, the layer a write targets; `--scope`, whose legacy `scopes` block to read; and
// `--layers`, which has `get` name the layer of every leaf instead of printing the bare value.
const FLAGS: ReadonlySet<string> = new Set(["layer", "scope", "layers"]);
const COUNT = { list: 1, path: 1, get: 2, set: 3, unset: 2 };

type Request = {
	sub: keyof typeof COUNT;
	key?: string;
	input?: string;
	target?: ConfigSettings.Target;
	scope?: string;
	layers: boolean;
};

const USAGE = [
	"kabane config [list|get <key> [--layers]|set <key> <value>|unset <key>|path] [--layer global|local|shared] [--scope <scope>] [--json]",
	"",
	"A setting resolves lowest first: its default; global, config.json, for every project;",
	"shared, the project's checked-in .kabane/<namespace>.json; local, your settings for this",
	"project on this device, kept under KABANE_HOME/projects/; then a command's own flags.",
	"set and unset write local inside a project and global outside one, unless --layer names",
	"another. Device keys (copilot, sync, db, timezone, ...) have the global layer only.",
	"--scope reads another project's legacy scopes.<id> block in config.json.",
	"get --layers prints every leaf under the key with the layer it came from.",
].join("\n");

const isSub = (sub: string): sub is Request["sub"] => Object.hasOwn(COUNT, sub);

/** What is wrong with how `--layer`, `--layers` and `--scope` are given to `sub`, if anything. */
const flagMisuse = (
	args: ParsedArgs,
	sub: Request["sub"],
): string | undefined => {
	if ("layer" in args.flags && sub !== "set" && sub !== "unset")
		return "--layer applies to set and unset";
	if ("layers" in args.flags && sub !== "get") return "--layers applies to get";
	if ("layers" in args.flags && args.flags.layers !== true)
		return "--layers takes no value: kabane config get <key> --layers";
	if ("scope" in args.flags && flagString(args, "scope") === undefined)
		return "--scope takes a scope URI or id";
	return undefined;
};

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
	const misused = flagMisuse(args, sub);
	if (misused !== undefined) return err(usage(misused, USAGE));
	const scope = flagString(args, "scope");
	// Without --layer the write's key and where it runs decide. A bare --layer names none, rather
	// than falling back to a layer the human did not pick.
	const target =
		"layer" in args.flags
			? ConfigSettings.targetOf(flagString(args, "layer") ?? "")
			: undefined;
	if ("layer" in args.flags && target === undefined)
		return err(
			usage(`--layer takes one of ${ConfigSettings.TARGETS.join(", ")}`, USAGE),
		);
	return ok({
		sub,
		...(target === undefined ? {} : { target }),
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
		// Global is config.json, which `config path` names; another layer names its file.
		const { layer, from, unset, stillSetIn } = changed.value;
		return success(
			changed.value,
			`${key} ${unset ? "unset" : `= ${display(changed.value.value)}`} (${layer === "global" ? layer : `${layer}: ${from}`})${stillSetIn === undefined ? "" : `; still set in ${stillSetIn}, which now decides`}`,
		);
	},
};
