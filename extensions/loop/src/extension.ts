// The loop as an official extension: one `kabane loop` command whose first positional picks the
// entry point. The CLI has already wired the runtime (`openContext`) by the time `run` is called.
import { resolve } from "node:path";
import { Harnesses } from "@cabane/acp";
import {
	type Extension,
	failure,
	flagString,
	type ParsedArgs,
	success,
	usage,
} from "@cabane/extension";
import { LoopActivity } from "./activity";
import { Loop } from "./commands";
import type { LoopConfig } from "./config";
import { LoopHeader } from "./header";
import type { RunStore } from "./store";

const USAGE = `kabane loop start <parent> [--dir <path>] [--implementer claude|codex|gemini] [--model <name>] [--concurrency <n>] [--wall-minutes <n>] [--continuations <n>] [--spend <amount>]
       kabane loop run <runId>
       kabane loop status [<runId>]
       kabane loop stop <runId>`;

// The executable the runner and each session's MCP server run as: this process's own entry.
const kabaneBin = (): string => {
	const entry = process.argv[1];
	return entry ? resolve(entry) : "kabane";
};

const number = (args: ParsedArgs, flag: string): number | undefined => {
	const value = flagString(args, flag);
	return value === undefined ? undefined : Number(value);
};

// Flags become config overrides; LoopConfig validates them with the repo file.
const configFrom = (args: ParsedArgs): LoopConfig.Input => {
	const implementer = flagString(args, "implementer");
	const model = flagString(args, "model");
	const budget = Object.fromEntries(
		[
			["concurrency", number(args, "concurrency")],
			["wallMinutes", number(args, "wall-minutes")],
			["continuations", number(args, "continuations")],
			["spend", number(args, "spend")],
		].filter(([, value]) => value !== undefined),
	);
	return {
		...(implementer && Harnesses.isId(implementer) ? { implementer } : {}),
		...(model ? { model } : {}),
		budget,
	};
};

const line = (run: RunStore.Run): string =>
	[
		run.id,
		run.status,
		run.parentShortId,
		`${run.claims.length} claims`,
		run.exit
			? `${run.exit.reason}${run.exit.detail ? ` (${run.exit.detail})` : ""}`
			: "",
	]
		.filter((part) => part !== "")
		.join("  ");

const command: Extension.Command = {
	name: "loop",
	summary:
		"Drive a parent issue's subtasks to completion through coding harnesses",
	usage: USAGE,
	run: async (args, ctx) => {
		const [verb, target] = args.positionals;
		const deps = {
			home: ctx.home,
			basePath: ctx.store,
			kabaneBin: kabaneBin(),
		};
		const done = (
			result: { ok: true; value: RunStore.Run } | { ok: false; error: Error },
		) =>
			result.ok
				? success(result.value, line(result.value))
				: failure(result.error);
		switch (verb) {
			case "start": {
				if (!target) return usage("start needs a parent issue", USAGE);
				const implementer = flagString(args, "implementer");
				if (implementer && !Harnesses.isId(implementer))
					return usage(
						`--implementer must be one of ${Harnesses.IDS.join(", ")}`,
						USAGE,
					);
				const dir = flagString(args, "dir");
				return done(
					await Loop.start(
						{ ...deps, cwd: ctx.cwd },
						{
							parent: target,
							...(dir ? { dir } : {}),
							config: configFrom(args),
						},
					),
				);
			}
			case "run":
				if (!target) return usage("run needs a run id", USAGE);
				return done(await Loop.run(deps, target));
			case "stop":
				if (!target) return usage("stop needs a run id", USAGE);
				return done(await Loop.stop(deps, target));
			case "status": {
				if (target) return done(Loop.status(deps, target));
				const runs = Loop.list(deps);
				return runs.ok
					? success(
							runs.value,
							runs.value.map(line).join("\n") || "No loop runs",
						)
					: failure(runs.error);
			}
			default:
				return usage(
					verb ? `Unknown loop command: ${verb}` : "Missing loop command",
					USAGE,
				);
		}
	},
};

export const loop: Extension = {
	name: "loop",
	commands: [command],
	// Each run on this device is a card with a tab of its own on the board, headed by the run's state.
	board: (ctx) => ({
		activity: LoopActivity.source(ctx.home),
		headers: { [LoopActivity.KIND]: LoopHeader.make(ctx.home, ctx.store) },
	}),
};
