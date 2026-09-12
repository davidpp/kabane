/**
 * Device configuration: `CABANE_HOME/config.json`.
 *
 * `CABANE_HOME` defaults to `~/.cabane`. By default the database lives beside
 * the config as `cabane.db` with plain table names; an optional `db` block
 * points the CLI at another SQLite file and prefix instead, which is how a Jake
 * user opens `~/.jake/jake.db` (`planner_` tables) with zero migration. Nothing
 * here touches the database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	err,
	ok,
	type Result,
	SyncConfigSchema,
	toError,
	trySync,
} from "@cabane/core";
import { MARKER_DIR, SCOPE_FILE } from "@cabane/core/scope";
import { z } from "zod";

export const DbConfigSchema = z.object({
	/** SQLite file to open instead of `CABANE_HOME/cabane.db`; `~` expands. */
	path: z.string().min(1).optional(),
	/** Table-name prefix inside that file (`planner_` for a Jake database). */
	tablePrefix: z.string().optional(),
});
export type DbConfig = z.infer<typeof DbConfigSchema>;

export const CopilotConfigSchema = z.object({
	/**
	 * Which harness the board's `A` prompt talks to. A plain string rather than
	 * an enum: the list of harnesses lives in `@cabane/acp`, and importing it
	 * here would put an ACP SDK load on the startup of every other command.
	 * `cabane board` validates the value against the registry.
	 */
	harness: z.string().min(1).default("claude"),
	/** Launch the harness with this command instead of the pinned adapter. */
	command: z.string().min(1).optional(),
	/** Arguments for `command`. The pinned adapter's own are not kept. */
	args: z.array(z.string()).optional(),
});
export type CopilotConfig = z.infer<typeof CopilotConfigSchema>;

export const ConfigSchema = z.object({
	/** Actor URI stamped on what this device writes. */
	actor: z.string().min(1),
	/** Seeds the sync device identity on first arming; write-once afterwards. */
	deviceId: z.string().min(1),
	sync: SyncConfigSchema.default({}),
	db: DbConfigSchema.optional(),
	/** The board copilot. Absent is the default harness with its pinned adapter. */
	copilot: CopilotConfigSchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export type DatabaseLocation = {
	/** The base path core receives; the provider joins `dbName` onto it. */
	basePath: string;
	dbName: string;
	tablePrefix: string;
};

export const CONFIG_FILE = "config.json";
export const DB_NAME = "cabane.db";
export { MARKER_DIR, SCOPE_FILE };

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string =>
	env.CABANE_HOME && env.CABANE_HOME.length > 0
		? env.CABANE_HOME
		: join(homedir(), ".cabane");

export const configPath = (home: string): string => join(home, CONFIG_FILE);

export const expandHome = (path: string): string =>
	path === "~"
		? homedir()
		: path.startsWith("~/")
			? join(homedir(), path.slice(2))
			: path;

/**
 * Where the database is. The provider only knows `basePath` + `dbName`, so an
 * explicit file path is split into its directory and file name; the rest of the
 * CLI hands `basePath` to core as the storage handle.
 */
export const databaseLocation = (
	home: string,
	config: Pick<Config, "db">,
): DatabaseLocation => {
	const tablePrefix = config.db?.tablePrefix ?? "";
	if (config.db?.path === undefined) {
		return { basePath: home, dbName: DB_NAME, tablePrefix };
	}
	const file = resolve(expandHome(config.db.path));
	return { basePath: dirname(file), dbName: basename(file), tablePrefix };
};

export const defaultActor = (): string =>
	`cabane://actor/human/${userInfo().username}`;

export const defaultDeviceId = (): string =>
	hostname().split(".")[0] ?? "device";

export const loadConfig = (home: string): Result<Config> => {
	const path = configPath(home);
	if (!existsSync(path)) {
		return err(new Error(`No config at ${path}. Run \`cabane init\` first.`));
	}
	const raw = trySync(() => JSON.parse(readFileSync(path, "utf8")));
	if (!raw.ok) return err(toError(raw.error));
	const parsed = ConfigSchema.safeParse(raw.value);
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`Invalid config at ${path}: ${parsed.error.message}`));
};

export const saveConfig = (home: string, config: Config): Result<string> => {
	const path = configPath(home);
	const written = trySync(() => {
		mkdirSync(home, { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

/**
 * `cabane init --scope` pins the scope for a directory tree. Reading it back is
 * the first step of `detectScope`'s cascade, so nothing here reads it.
 */
export const writeDirectoryScope = (
	cwd: string,
	scope: string,
): Result<string> => {
	const path = join(cwd, SCOPE_FILE);
	const written = trySync(() => {
		mkdirSync(join(cwd, MARKER_DIR), { recursive: true });
		writeFileSync(path, `${scope.trim()}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

/** Human authors comment as `human`; agent actor URIs comment as `ai`. */
export const authorTypeOf = (actor: string): "human" | "ai" =>
	actor.startsWith("cabane://actor/agent/") ? "ai" : "human";
