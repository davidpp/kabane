/**
 * `cabane` entry: pick the command, open the context, print the outcome.
 *
 * Exit codes: 0 ok, 1 error, 2 usage. `--json` on any command prints the
 * outcome's JSON instead of the human text.
 */

import { flagBool, parseArgs } from "./args";
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
import { upstream } from "./commands/upstream";
import { resolveHome } from "./config";
import { type Command, type Ctx, openContext } from "./context";
import { openTui } from "./first-run";
import { failure, type Outcome, print, usage } from "./output";

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
];

export const helpText = (): string =>
	[
		"cabane — local-first tracker for humans and agent runtimes",
		"",
		"Usage: cabane <command> [args] [--json] [--as <actor-uri>]",
		"",
		...COMMANDS.map((c) => `  ${c.name.padEnd(9)} ${c.summary}`),
		"",
		"CABANE_HOME (default ~/.cabane) holds config.json and cabane.db, unless config.json's db block points at another file.",
	].join("\n");

const HELP_USAGE = "cabane <command> [args]";

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
	if (!name || name === "help" || name === "--help" || name === "-h") {
		return {
			exitCode: name ? 0 : 2,
			json: { commands: COMMANDS.map((c) => c.name) },
			text: helpText(),
		};
	}
	const command = COMMANDS.find((c) => c.name === name);
	if (!command) return usage(`Unknown command: ${name}`, HELP_USAGE);

	const args = parseArgs(rest);
	if (flagBool(args, "help"))
		return { exitCode: 0, json: { usage: command.usage }, text: command.usage };

	const home = resolveHome(env);
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
