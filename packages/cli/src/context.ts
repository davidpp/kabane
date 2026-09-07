/**
 * Command context: the resolved home, its config, and the wired runtime.
 *
 * `Runtime.configure` happens once per process, here. Every command receives
 * the same `Ctx` and calls core with `ctx.store` as the base path, which is the
 * home unless `config.db.path` points elsewhere.
 */

import { ok, Planner, type Result, Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import type { ParsedArgs } from "./args";
import { flagString } from "./args";
import {
	type Config,
	type DatabaseLocation,
	databaseLocation,
	directoryScope,
	loadConfig,
} from "./config";
import type { Outcome } from "./output";

export type Ctx = {
	/** CABANE_HOME: where config.json lives. */
	home: string;
	/** The storage handle every core call receives (the database's directory). */
	store: string;
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

/**
 * `actor` is stamped into `updated_by` on every local write, so it has to be
 * the effective one for this invocation (`--as` wins over the config).
 */
export const configureRuntime = (
	config: Config,
	actor: string,
	location: DatabaseLocation,
): void => {
	Runtime.configure({
		provider: SqliteDb.provider({ dbName: location.dbName }),
		tablePrefix: location.tablePrefix,
		actor: () => actor,
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
	const actor = flagString(args, "as") ?? config.value.actor;
	const location = databaseLocation(home, config.value);
	configureRuntime(config.value, actor, location);
	const initialized = await Planner.init(location.basePath);
	if (!initialized.ok) return initialized;
	return ok({
		home,
		store: location.basePath,
		cwd,
		config: config.value,
		actor,
	});
};

/** `--scope` wins, then `./.cabane/scope`, then nothing. */
export const resolveScope = (args: ParsedArgs, ctx: Ctx): string | undefined =>
	flagString(args, "scope") ?? directoryScope(ctx.cwd);
