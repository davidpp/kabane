/**
 * Device configuration: `KABANE_HOME/config.json`.
 *
 * `KABANE_HOME` defaults to `~/.kabane`. By default the database lives beside
 * the config as `kabane.db` with plain table names; an optional `db` block
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
	TimeZoneSchema,
	toError,
	trySync,
} from "@cabane/core";
import { MARKER_DIR, SCOPE_FILE } from "@cabane/core/scope";
import type { Extension } from "@cabane/extension";
import { z } from "zod";

const DbConfigSchema = z.object({
	path: z
		.string()
		.min(1)
		.optional()
		.describe("SQLite file instead of KABANE_HOME/kabane.db; ~ expands."),
	tablePrefix: z
		.string()
		.optional()
		.describe("Table-name prefix (planner_ for a Jake database)."),
});
export type DbConfig = z.infer<typeof DbConfigSchema>;

const CopilotConfigSchema = z.object({
	// A plain string, not an enum, so a config naming a harness a newer kabane added still loads.
	// `config set` and `kabane board` check it against @cabane/acp/harnesses, which is ID-only:
	// the package root would load the ACP SDK on every command.
	harness: z
		.string()
		.min(1)
		.default("claude")
		.describe("Harness for the board's A prompt; defaults to claude."),
	command: z
		.string()
		.min(1)
		.optional()
		.describe("Launch command overriding the pinned harness adapter."),
	args: z
		.array(z.string())
		.optional()
		.describe(
			"Arguments for the custom command, replacing the adapter's arguments.",
		),
	// The harness's own pin is Sonnet for Claude, because a board turn is triage against a planner.
	// Harnesses whose model variable the registry does not name ignore this.
	model: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Harness model name; absent uses its pinned model when supported.",
		),
});

const HarnessConfigSchema = z.object({
	/**
	 * The mode every harness session (the copilot, loop implementers and
	 * lenses) starts in. `auto` moves a session that opens in the harness's
	 * manual mode to the harness's own auto mode, where the harness decides
	 * which tool calls need a human; `default` leaves the mode the harness and
	 * your own settings start it in. Literal values for the same reason as
	 * `copilot.harness`; `@cabane/acp` names them `Harnesses.MODES`.
	 */
	mode: z
		.enum(["auto", "default"])
		.optional()
		.describe(
			"auto (default) starts sessions in the harness's own auto mode; default keeps the harness's own start mode.",
		),
});

export const ConfigSchema = z.object({
	actor: z
		.string()
		.min(1)
		.describe("Actor URI stamped on this device's writes (read-only)."),
	deviceId: z
		.string()
		.min(1)
		.describe("Initial sync device identity (read-only, write-once)."),
	sync: SyncConfigSchema.default({}).describe(
		"Multi-device replication settings; edit dotted keys.",
	),
	db: DbConfigSchema.optional().describe(
		"Alternate SQLite location and table prefix; edit dotted keys.",
	),
	copilot: CopilotConfigSchema.optional().describe(
		"Board copilot settings; absent uses the default harness and pinned adapter.",
	),
	harness: HarnessConfigSchema.optional().describe(
		"Every harness session's mode; absent is auto (the harness's own auto mode).",
	),
	timezone: TimeZoneSchema.optional().describe(
		"Owner's IANA timezone for deadlines and today; absent uses the system zone (TZ).",
	),
	// Strings allow newer or removed extensions to leave the config readable.
	extensions: z
		.array(z.string().min(1))
		.optional()
		.describe("Enabled official extension names; absent enables none."),
});
export type Config = z.infer<typeof ConfigSchema>;

export const harnessMode = (
	config: Pick<Config, "harness">,
): Extension.Ctx["harnessMode"] => config.harness?.mode ?? "auto";

export type DatabaseLocation = {
	/** The base path core receives; the provider joins `dbName` onto it. */
	basePath: string;
	dbName: string;
	tablePrefix: string;
};

const CONFIG_FILE = "config.json";
const DB_NAME = "kabane.db";
export { SCOPE_FILE };

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string =>
	env.KABANE_HOME && env.KABANE_HOME.length > 0
		? env.KABANE_HOME
		: join(homedir(), ".kabane");

export const configPath = (home: string): string => join(home, CONFIG_FILE);

const expandHome = (path: string): string =>
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

export const isPlainObject = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Keep the stored document alongside resolved defaults so edits retain unknown keys. */
export const loadConfigDocument = (
	home: string,
): Result<{
	stored: Record<string, unknown>;
	config: Config;
}> => {
	const path = configPath(home);
	if (!existsSync(path)) {
		return err(new Error(`No config at ${path}. Run \`kabane init\` first.`));
	}
	const raw = trySync((): unknown => JSON.parse(readFileSync(path, "utf8")));
	if (!raw.ok) return err(toError(raw.error));
	const parsed = ConfigSchema.safeParse(raw.value);
	if (!parsed.success || !isPlainObject(raw.value)) {
		return err(
			new Error(
				`Invalid config at ${path}: ${!parsed.success ? parsed.error.message : "expected an object"}`,
			),
		);
	}
	return ok({ stored: raw.value, config: parsed.data });
};

export const loadConfig = (home: string): Result<Config> => {
	const document = loadConfigDocument(home);
	return document.ok ? ok(document.value.config) : document;
};

export const saveConfig = (home: string, config: unknown): Result<string> => {
	const path = configPath(home);
	const parsed = ConfigSchema.safeParse(config);
	if (!parsed.success)
		return err(new Error(`Invalid config at ${path}: ${parsed.error.message}`));
	const written = trySync(() => {
		mkdirSync(home, { recursive: true });
		// Write the input, not parsed.data: defaults stay absent and unknown keys survive.
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

/**
 * `kabane init --scope` pins the scope for a directory tree. Reading it back is
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
