/**
 * `kabane` entry: pick the command, open the context, print the outcome.
 *
 * Exit codes: 0 ok, 1 error, 2 usage. `--json` on any command prints the
 * outcome's JSON instead of the human text.
 */

import { err, ok, type Result } from "@cabane/core";
import {
	type Extension,
	failure,
	flagBool,
	type Outcome,
	parseArgs,
	usage,
} from "@cabane/extension";
import { add } from "./commands/add";
import { board } from "./commands/board";
import { comment } from "./commands/comment";
import { context } from "./commands/context";
import { done } from "./commands/done";
import { edit } from "./commands/edit";
import { init } from "./commands/init";
import { link } from "./commands/link";
import { list } from "./commands/list";
import { log } from "./commands/log";
import { mcp } from "./commands/mcp";
import { open } from "./commands/open";
import { search } from "./commands/search";
import { show } from "./commands/show";
import { sync } from "./commands/sync";
import { update } from "./commands/update";
import { upstream } from "./commands/upstream";
import { resolveHome } from "./config";
import { type Command, type Ctx, openContext } from "./context";
import { Extensions } from "./extensions";
import { openTui } from "./first-run";
import { print } from "./output";
import { describeVersion } from "./version";

export const COMMANDS: Command[] = [
	init,
	add,
	list,
	show,
	edit,
	done,
	search,
	link,
	upstream,
	open,
	comment,
	log,
	context,
	sync,
	board,
	mcp,
	update,
];

/** The built-ins, then what the enabled extensions add. */
export const helpText = (
	fromExtensions: readonly Extension.Command[] = [],
): string =>
	[
		"kabane — local-first tracker for humans and agent runtimes",
		"",
		"Usage: kabane <command> [args] [--json] [--as <actor-uri>]",
		"       kabane --version",
		"",
		...[...COMMANDS, ...fromExtensions].map(
			(c) => `  ${c.name.padEnd(9)} ${c.summary}`,
		),
		"",
		"KABANE_HOME (default ~/.kabane) holds config.json and kabane.db, unless config.json's db block points at another file.",
	].join("\n");

const HELP_USAGE = "kabane <command> [args]";

const extensionCommands = async (
	home: string,
): Promise<Result<Extension.Command[]>> => {
	const names = Extensions.enabled(home);
	if (!names.ok) return names;
	const loaded = await Extensions.loadAll(names.value);
	return loaded.ok
		? ok(loaded.value.flatMap((extension) => extension.commands ?? []))
		: loaded;
};

/** Help lists the enabled extensions' commands, and still prints when one of them is broken. */
const help = async (home: string, exitCode: 0 | 2): Promise<Outcome> => {
	const extra = await extensionCommands(home);
	const commands = [...COMMANDS, ...(extra.ok ? extra.value : [])];
	return {
		exitCode,
		json: { commands: commands.map((c) => c.name) },
		text: extra.ok
			? helpText(extra.value)
			: `${helpText()}\n\nExtensions unavailable: ${extra.error.message}`,
	};
};

/**
 * A built-in wins; otherwise an enabled extension's command, which is only
 * imported now. The error is the outcome to print instead.
 */
const resolveCommand = async (
	name: string,
	home: string,
): Promise<Result<Command, Outcome>> => {
	const builtIn = COMMANDS.find((c) => c.name === name);
	if (builtIn) return ok(builtIn);
	const enabled = Extensions.enabled(home);
	if (!enabled.ok) return err(failure(enabled.error));
	const found = await Extensions.find(name, enabled.value);
	if (!found.ok) return err(failure(found.error));
	switch (found.value.found) {
		case "enabled":
			return ok(found.value.command);
		case "disabled":
			return err(
				failure(Extensions.enableHint(name, found.value.extension, home)),
			);
		case "none":
			return err(usage(`Unknown command: ${name}`, HELP_USAGE));
	}
};

/** A context init and mcp can run with: no config file needed. */
const bareCtx = (home: string, cwd: string): Ctx => ({
	home,
	store: home,
	cwd,
	config: {
		actor: "",
		deviceId: "",
		sync: { enabled: false, batchBytes: 262144 },
	},
	actor: "",
});

export const run = async (
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): Promise<Outcome> => {
	const [name, ...rest] = argv;
	// A human at a terminal gets the board (setup first on a new device); a
	// pipe or an agent still gets help, as it always has.
	if (!name && process.stdin.isTTY && process.stdout.isTTY)
		return openTui(resolveHome(env), cwd);
	if (name === "--version" || name === "-v") {
		const { text, ...json } = describeVersion();
		return { exitCode: 0, json, text };
	}
	const home = resolveHome(env);
	if (!name || name === "help" || name === "--help" || name === "-h")
		return help(home, name ? 0 : 2);
	const resolved = await resolveCommand(name, home);
	if (!resolved.ok) return resolved.error;
	const command = resolved.value;

	const args = parseArgs(rest);
	if (flagBool(args, "help"))
		return { exitCode: 0, json: { usage: command.usage }, text: command.usage };

	if (command.standalone) return command.run(args, bareCtx(home, cwd));

	const ctx = await openContext(home, cwd, args);
	if (!ctx.ok) return failure(ctx.error);
	return command.run(args, ctx.value);
};

export const main = async (argv: string[]): Promise<number> => {
	const json = argv.includes("--json");
	const outcome = await run(argv.filter((a) => a !== "--json"));
	print(outcome, json);
	return outcome.exitCode;
};
