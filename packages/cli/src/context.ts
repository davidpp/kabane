/**
 * Command context: the resolved home, its config, and the wired runtime.
 *
 * `Runtime.configure` happens once per process, here. Every command receives
 * the same `Ctx` and calls core with `ctx.store` as the base path, which is the
 * home.
 */

import { existsSync } from "node:fs";
import { checklistModule } from "@cabane/checklist";
import {
	err,
	type KabaneModule,
	type ProjectScope,
	normalizeScopeUri,
	ok,
	Planner,
	type Result,
	type ToolContext,
	Runtime,
	tryCatch,
} from "@cabane/core";
import {
	type Extension,
	flagString,
	type ParsedArgs,
	Settings,
} from "@cabane/extension";
import { handoffModule } from "@cabane/handoff";
import { outcomeModule } from "@cabane/outcome";
import { questionsModule } from "@cabane/questions";
import { SqliteDb } from "@cabane/sqlite";
import {
	type Config,
	configPath,
	DB_NAME,
	loadConfig,
	loadConfigDocument,
} from "./config";
import { ConfigLayers } from "./config-layers";
import { Extensions } from "./extensions";
import { activateHostRecord, hostHarnessMode } from "./host";
import { detectScope, mainCheckoutRoot } from "./scope/detect";

/** An extension's context plus the device config, which only built-in commands read. */
export type Ctx = Extension.Ctx & { config: Config };

/** A built-in command; an extension's command, which asks for less, fits it too. */
export type Command = Extension.Command<Ctx>;

/**
 * `actor` is stamped into `updated_by` on every local write, so it has to be
 * the effective one for this invocation (`--as` wins over the config).
 */
/** The data modules every device registers, in the order their sections render. */
export const MODULES = [
	questionsModule,
	handoffModule,
	outcomeModule,
	checklistModule,
];

/** Wire the runtime with the first-party modules, then `extensions` (enabled extensions' modules). */
export const configureRuntime = (
	config: Config,
	actor: string,
	extensions: readonly KabaneModule[] = [],
): Result<void> => {
	const zone = config.timezone;
	return Runtime.configure({
		modules: [...MODULES, ...extensions],
		provider: SqliteDb.provider({ dbName: DB_NAME }),
		actor: () => actor,
		fileReader: async (path, cap) => {
			try {
				const file = Bun.file(path);
				if (!(await file.exists())) return { status: "missing" };
				const size = file.size;
				return { status: "read", size, head: await file.slice(0, cap).text() };
			} catch {
				return { status: "pointer" };
			}
		},
		syncSettings: async () => ok(config.sync),
		// Absent, the runtime's default: the system zone, which honours `TZ`.
		timezone: zone === undefined ? undefined : () => zone,
	});
};

/**
 * The stages before migration (`ARCHITECTURE.md`, "Every process that opens the database
 * registers the same modules"): each enabled extension's manifest read and `api` checked, its
 * modules entry imported and its factory called with its host, then `Runtime.configure` with
 * the first-party modules and the extensions' in `extensions` order. An `err` is the stop's one
 * line: a process that opens the database must not go on without an enabled extension's modules.
 */
export const registerModules = async (
	home: string,
	config: Config,
	actor: string,
): Promise<Result<void>> => {
	const enabled = config.extensions ?? [];
	const contributed = await Extensions.modules(enabled, home);
	if (!contributed.ok) return contributed;
	const modules: KabaneModule[] = [];
	// One extension at a time, so a refused set names the extension whose modules it refused.
	for (const { name, modules: own } of contributed.value) {
		modules.push(...own);
		const configured = configureRuntime(config, actor, modules);
		if (!configured.ok)
			return err(
				new Error(
					Extensions.stopLine(
						home,
						enabled,
						name,
						`its data modules were refused: ${configured.error.message}`,
					),
				),
			);
	}
	return modules.length > 0 ? ok(undefined) : configureRuntime(config, actor);
};

/** Load config, register every module, ensure the schema. */
export const openContext = async (
	home: string,
	cwd: string,
	args: ParsedArgs,
): Promise<Result<Ctx>> => {
	activateHostRecord(home);
	const config = loadConfig(home);
	if (!config.ok) return config;
	const actor = flagString(args, "as") ?? config.value.actor;
	const registered = await registerModules(home, config.value, actor);
	if (!registered.ok) return registered;
	const initialized = await Planner.init(home);
	if (!initialized.ok) return initialized;
	const ctx: Ctx = {
		home,
		store: home,
		cwd,
		config: config.value,
		actor,
		harnessMode: hostHarnessMode(home, config.value),
		settings: settingsPort(home),
	};
	activateContextRecord(ctx, args);
	return ok(ctx);
};

/** Doctor and commands publish the same identity and lazily resolved scope. */
export const activateContextRecord = (ctx: Ctx, args: ParsedArgs): void => {
	let context: Promise<ToolContext> | undefined;
	activateHostRecord(
		ctx.home,
		() =>
			(context ??= resolveScopeUri(args, ctx).then((defaultScope) => ({
				basePath: ctx.store,
				actor: ctx.actor,
				humanActor: ctx.config.actor,
				defaultScope,
				scopeRequired: false,
			}))),
	);
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
	if (explicit) {
		// The URI rows are stored under, so a bare id or the scheme before schema 10 names the
		// same scope wherever this one is compared to a row's. An unusable one goes on as typed,
		// for storage to refuse with its own message.
		const normalized = normalizeScopeUri(explicit);
		return {
			scopeUri: normalized.ok ? normalized.value : explicit,
			label: explicit,
		};
	}

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
