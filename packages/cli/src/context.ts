/**
 * Command context: the resolved home, its config, and the wired runtime.
 *
 * `Runtime.configure` happens once per process, here. Every command receives
 * the same `Ctx` and calls core with `ctx.store` as the base path, which is the
 * home unless `config.db.path` points elsewhere.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, Planner, type Result, Runtime } from "@cabane/core";
import { detectScope } from "@cabane/core/scope";
import { SqliteDb } from "@cabane/sqlite";
import type { ParsedArgs } from "./args";
import { flagString } from "./args";
import {
	type Config,
	type DatabaseLocation,
	databaseLocation,
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

/** A scope to filter on or file under, with the name a UI should show for it. */
export type ScopeSelection = {
	scopeUri: string;
	label: string;
};

/**
 * Jake pins a project's identity in `<root>/.jake/config.json`. A device
 * configured with `db.path` pointing at a Jake database inherits its tasks, so
 * it has to inherit that pin too: resolving the same repo to its git remote
 * instead would be a different scope id, and every task already filed there
 * would drop out of the filter.
 */
const jakeProjectPin = async (root: string): Promise<string | null> => {
	try {
		const raw = await readFile(join(root, ".jake", "config.json"), "utf8");
		const id = (JSON.parse(raw) as { project?: { id?: unknown } }).project?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
};

/**
 * `--scope` wins; otherwise the working directory decides, so a command run
 * anywhere inside a project — its root, a nested package, or a worktree —
 * lands on the same scope without any per-repo setup.
 */
export const resolveScope = async (
	args: ParsedArgs,
	ctx: Ctx,
): Promise<ScopeSelection | undefined> => {
	const explicit = flagString(args, "scope");
	if (explicit) return { scopeUri: explicit, label: explicit };

	const detected = await detectScope(ctx.cwd, {
		home: ctx.home,
		legacyPin: jakeProjectPin,
	});
	return detected
		? { scopeUri: detected.scopeUri, label: detected.name }
		: undefined;
};

/** The scope a query filters on; `resolveScope` without the display half. */
export const resolveScopeUri = async (
	args: ParsedArgs,
	ctx: Ctx,
): Promise<string | undefined> => (await resolveScope(args, ctx))?.scopeUri;
