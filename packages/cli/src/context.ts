/**
 * Command context: the resolved home, its config, and the wired runtime.
 *
 * `Runtime.configure` happens once per process, here. Every command receives
 * the same `Ctx` and calls core with `ctx.home` as the base path.
 */

import { ok, Planner, type Result, Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import type { ParsedArgs } from "./args";
import { flagString } from "./args";
import { type Config, DB_NAME, directoryScope, loadConfig } from "./config";
import type { Outcome } from "./output";

export type Ctx = {
	home: string;
	cwd: string;
	config: Config;
	/** The actor for this invocation: `--as`, else the configured one. */
	actor: string;
};

export type Command = {
	name: string;
	usage: string;
	summary: string;
	/** Runs without a config file (init, help). */
	standalone?: boolean;
	run: (args: ParsedArgs, ctx: Ctx) => Promise<Outcome>;
};

export const configureRuntime = (config: Config): void => {
	Runtime.configure({
		provider: SqliteDb.provider({ dbName: DB_NAME }),
		tablePrefix: "",
		syncSettings: async () => ok(config.sync),
	});
};

/** Load config, wire the runtime, ensure the schema. */
export const openContext = async (
	home: string,
	cwd: string,
	args: ParsedArgs,
): Promise<Result<Ctx>> => {
	const config = loadConfig(home);
	if (!config.ok) return config;
	configureRuntime(config.value);
	const initialized = await Planner.init(home);
	if (!initialized.ok) return initialized;
	return ok({
		home,
		cwd,
		config: config.value,
		actor: flagString(args, "as") ?? config.value.actor,
	});
};

/** `--scope` wins, then `./.cabane/scope`, then nothing. */
export const resolveScope = (args: ParsedArgs, ctx: Ctx): string | undefined =>
	flagString(args, "scope") ?? directoryScope(ctx.cwd);
