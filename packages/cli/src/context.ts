/**
 * Command context: the resolved home, its config, and the wired runtime.
 *
 * `Runtime.configure` happens once per process, here. Every command receives
 * the same `Ctx` and calls core with `ctx.store` as the base path, which is the
 * home.
 */

import { existsSync } from "node:fs";
import { checklistModule } from "@cabane/checklist";
import { ok, Planner, type Result, Runtime, tryCatch } from "@cabane/core";
import {
	detectScope,
	mainCheckoutRoot,
	type ProjectScope,
} from "@cabane/core/scope";
import {
	type Extension,
	flagString,
	type ParsedArgs,
	Settings,
} from "@cabane/extension";
import { handoffModule } from "@cabane/handoff";
import { questionsModule } from "@cabane/questions";
import { SqliteDb } from "@cabane/sqlite";
import {
	type Config,
	configPath,
	DB_NAME,
	harnessMode,
	loadConfig,
	loadConfigDocument,
} from "./config";
import { ConfigLayers } from "./config-layers";

/** An extension's context plus the device config, which only built-in commands read. */
export type Ctx = Extension.Ctx & { config: Config };

/** A built-in command; an extension's command, which asks for less, fits it too. */
export type Command = Extension.Command<Ctx>;

/**
 * `actor` is stamped into `updated_by` on every local write, so it has to be
 * the effective one for this invocation (`--as` wins over the config).
 */
/** The data modules every device registers, in the order their sections render. */
export const MODULES = [questionsModule, handoffModule, checklistModule];

export const configureRuntime = (
	config: Config,
	actor: string,
): Result<void> => {
	const zone = config.timezone;
	return Runtime.configure({
		modules: MODULES,
		provider: SqliteDb.provider({ dbName: DB_NAME }),
		actor: () => actor,
		syncSettings: async () => ok(config.sync),
		// Absent, the runtime's default: the system zone, which honours `TZ`.
		timezone: zone === undefined ? undefined : () => zone,
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
	const configured = configureRuntime(config.value, actor);
	if (!configured.ok) return configured;
	const initialized = await Planner.init(home);
	if (!initialized.ok) return initialized;
	return ok({
		home,
		store: home,
		cwd,
		config: config.value,
		actor,
		harnessMode: harnessMode(config.value),
		settings: settingsPort(home),
	});
};

/** A scope to filter on or file under, with the name a UI should show for it. */
export type ScopeSelection = {
	scopeUri: string;
	label: string;
	/**
	 * The project directory the scope was detected in — what a subprocess that
	 * should see the project gets as its cwd. Absent when `--scope` named the
	 * scope: a URI on the command line says nothing about where that project is
	 * checked out, or whether it is on this machine at all.
	 */
	root?: string;
};

/**
 * The project `cwd` sits in, the way every command resolves it, or null outside
 * one. Needs no config, so setup can ask it before the device has one.
 */
export const detectProject = (
	cwd: string,
	home: string,
): Promise<ProjectScope | null> => detectScope(cwd, { home });

/**
 * The project at `dir` without the extensions a filter ignores: its root, which keys its local
 * settings, and its scope id. Null outside one.
 */
export const projectAt = (
	dir: string,
	home: string,
): Promise<Result<ProjectScope | null>> =>
	tryCatch(() => detectScope(dir, { home, detectExtensions: false }));

/**
 * Settings through every layer for an extension. It reads `config.json` when it resolves, so a
 * context without a config (a standalone command's) still has the user's layers once there is one.
 */
export const settingsPort = (home: string): Settings.Port =>
	Settings.port(async (namespace, projectDir) => {
		const document = existsSync(configPath(home))
			? loadConfigDocument(home)
			: ok(undefined);
		if (!document.ok) return document;
		const project = await projectAt(projectDir, home);
		if (!project.ok) return project;
		const here = project.value;
		const localRoot = here
			? await tryCatch(() => mainCheckoutRoot(here.root))
			: ok(undefined);
		if (!localRoot.ok) return localRoot;
		// The shared file is the project root's, wherever inside the project the caller runs.
		return ConfigLayers.sources(home, document.value?.stored, namespace, {
			projectDir:
				(here && ConfigLayers.sharedRoot(here.root, projectDir)) ?? projectDir,
			...(here ? { scopeId: here.scopeId, localRoot: localRoot.value } : {}),
		});
	});

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

	const detected = await detectProject(ctx.cwd, ctx.home);
	return detected
		? { scopeUri: detected.scopeUri, label: detected.name, root: detected.root }
		: undefined;
};

/** The scope a query filters on; `resolveScope` without the display half. */
export const resolveScopeUri = async (
	args: ParsedArgs,
	ctx: Ctx,
): Promise<string | undefined> => (await resolveScope(args, ctx))?.scopeUri;
