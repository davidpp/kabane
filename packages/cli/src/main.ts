/**
 * `kabane` entry: pick the command, open the context, print the outcome.
 *
 * Exit codes: 0 ok, 1 error, 2 usage. `--json` on any command prints the
 * outcome's JSON instead of the human text.
 */

import { existsSync } from "node:fs";
import { err, ok, type Result } from "@kabane/core";
import {
	type Extension,
	failure,
	flagBool,
	type Outcome,
	parseArgs,
	usage,
} from "@kabane/extension";
import { add } from "./commands/add";
import { answer } from "./commands/answer";
import { board } from "./commands/board";
import { checklist } from "./commands/checklist";
import { comment } from "./commands/comment";
import { config } from "./commands/config";
import { context } from "./commands/context";
import { doctor } from "./commands/doctor";
import { done } from "./commands/done";
import { edit } from "./commands/edit";
import { handoff } from "./commands/handoff";
import { init } from "./commands/init";
import { link } from "./commands/link";
import { list } from "./commands/list";
import { log } from "./commands/log";
import { mcp } from "./commands/mcp";
import { open } from "./commands/open";
import { questions } from "./commands/questions";
import { scope } from "./commands/scope";
import { search } from "./commands/search";
import { show } from "./commands/show";
import { sync } from "./commands/sync";
import { update } from "./commands/update";
import { upstream } from "./commands/upstream";
import { configPath, resolveHome } from "./config";
import { type Command, type Ctx, openContext, settingsPort } from "./context";
import { Extensions } from "./extensions";
import { print } from "./output";
import { describeVersion } from "./version";

export const COMMANDS: Command[] = [
	init,
	config,
	doctor,
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
	questions,
	answer,
	checklist,
	handoff,
	log,
	context,
	scope,
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
		"KABANE_HOME (default ~/.kabane) holds config.json and kabane.db.",
		"How-to for kabane tasks (setting up kabane or an extension in a project, linking, settings,",
		"doctor) ships as skills: a session connected to `kabane mcp` lists them with kabane_skillList",
		"and follows one with kabane_skillGet.",
	].join("\n");

const HELP_USAGE = "kabane <command> [args]";

/** Help keeps every successfully loaded command and names each refusal. */
const help = async (home: string, exitCode: 0 | 2): Promise<Outcome> => {
	const names = Extensions.enabled(home);
	if (!names.ok)
		return {
			exitCode,
			json: { commands: COMMANDS.map((c) => c.name) },
			text: `${helpText()}\n\nExtensions unavailable: ${names.error.message}`,
		};
	const all = await Extensions.loadAll(names.value, home);
	Extensions.report(all.refused);
	const accepted = Extensions.commands(
		all.loaded,
		COMMANDS.map((command) => command.name),
	);
	Extensions.report(accepted.refused);
	const extra = accepted.commands;
	return {
		exitCode,
		json: { commands: [...COMMANDS, ...extra].map((c) => c.name) },
		text: helpText(extra),
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
	const all = await Extensions.loadAll(enabled.value, home);
	const accepted = Extensions.commands(
		all.loaded,
		COMMANDS.map((command) => command.name),
	);
	Extensions.report([...all.refused, ...accepted.refused]);
	const found = accepted.commands.find((command) => command.name === name);
	if (found) return ok(found);
	const disabled = Extensions.available(home).filter(
		(extension) => !enabled.value.includes(extension),
	);
	return err(
		usage(
			`Unknown command: ${name}${disabled.length ? `; installed extensions not enabled: ${disabled.join(", ")}. ${existsSync(configPath(home)) ? "Enable them" : "Run `kabane init` first, then enable them"} with \`kabane config set extensions <names> --layer global\` to discover their commands` : ""}`,
			HELP_USAGE,
		),
	);
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
	harnessMode: "auto",
	settings: settingsPort(home),
});

export const run = async (
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): Promise<Outcome> => {
	Extensions.forgetStop();
	const [name, ...rest] = argv;
	// A human at a terminal gets the board (setup first on a new device); a
	// pipe or an agent still gets help, as it always has.
	if (!name && process.stdin.isTTY && process.stdout.isTTY) {
		const { openTui } = await import("./first-run");
		return openTui(resolveHome(env), cwd);
	}
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
