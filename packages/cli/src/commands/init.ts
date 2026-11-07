import { existsSync } from "node:fs";
import { err, ok, Planner, type Result } from "@cabane/core";
import { failure, flagBool, flagString, success } from "@cabane/extension";
import {
	type Config,
	ConfigSchema,
	configPath,
	type DbConfig,
	databaseLocation,
	defaultActor,
	defaultDeviceId,
	SCOPE_FILE,
	saveConfig,
	writeDirectoryScope,
} from "../config";
import { type Command, configureRuntime } from "../context";

/**
 * The hub sits behind Cloudflare Access; a device passes the edge with a
 * service token carried as two headers on every push and pull. Both halves or
 * neither: one without the other is a typo, not a configuration.
 */
const accessHeaders = (
	clientId: string | undefined,
	clientSecret: string | undefined,
): Result<Record<string, string> | undefined> => {
	if (clientId === undefined && clientSecret === undefined)
		return ok(undefined);
	if (clientId === undefined || clientSecret === undefined) {
		return err(
			new Error(
				"--access-client-id and --access-client-secret must be given together",
			),
		);
	}
	return ok({
		"CF-Access-Client-Id": clientId,
		"CF-Access-Client-Secret": clientSecret,
	});
};

/**
 * The `db` block exists only when asked for, so a config written before it
 * existed keeps meaning `KABANE_HOME/kabane.db` with plain names. A Jake user
 * passes `--db-path ~/.jake/jake.db --table-prefix planner_` and shares Jake's
 * database instead of migrating.
 */
const dbBlock = (
	path: string | undefined,
	tablePrefix: string | undefined,
): DbConfig | undefined =>
	path === undefined && tablePrefix === undefined
		? undefined
		: { path, tablePrefix };

/** Everything a device's config is made of, as `init`'s flags or the setup screen give it. */
export type ConfigInput = {
	actor: string;
	deviceId: string;
	syncUrl?: string;
	syncToken?: string;
	accessClientId?: string;
	accessClientSecret?: string;
	dbPath?: string;
	tablePrefix?: string;
};

/**
 * The config half of `init`, with no file or database touched: `init` and the first-run setup
 * screen both build through here, so a device set up either way holds the same shape.
 */
export const buildConfig = (input: ConfigInput): Result<Config> => {
	const headers = accessHeaders(input.accessClientId, input.accessClientSecret);
	if (!headers.ok) return headers;
	const parsed = ConfigSchema.safeParse({
		actor: input.actor,
		deviceId: input.deviceId,
		sync: {
			enabled: input.syncUrl !== undefined && input.syncToken !== undefined,
			url: input.syncUrl,
			token: input.syncToken,
			headers: headers.value,
			deviceId: input.deviceId,
		},
		db: dbBlock(input.dbPath, input.tablePrefix),
	});
	return parsed.success
		? ok(parsed.data)
		: err(new Error(parsed.error.message));
};

/** The flags that write `config.json`; `--scope` alone writes only the directory's pin. */
const CONFIG_FLAGS = [
	"actor",
	"device",
	"sync-url",
	"sync-token",
	"access-client-id",
	"access-client-secret",
	"db-path",
	"table-prefix",
] as const;

/**
 * `--scope` is the one way to put a pin in a repo, since detection writes nothing there. A device
 * that already has a config pins with it alone, so pinning never costs the config a rewrite.
 */
const pinScope = (cwd: string, scope: string) => {
	const wrote = writeDirectoryScope(cwd, scope);
	if (!wrote.ok) return failure(wrote.error);
	return success(
		{ scope, pin: wrote.value },
		`✓ Pinned scope ${scope} in ./${SCOPE_FILE}`,
	);
};

export const init: Command = {
	name: "init",
	summary: "Create KABANE_HOME/config.json and the database",
	usage:
		"kabane init [--actor <uri>] [--device <id>] [--sync-url <url>] [--sync-token <token>] [--access-client-id <id> --access-client-secret <secret>] [--db-path <file> [--table-prefix <prefix>]] [--scope <uri>] [--force]",
	standalone: true,
	run: async (args, ctx) => {
		const path = configPath(ctx.home);
		const scope = flagString(args, "scope");
		if (existsSync(path) && !flagBool(args, "force")) {
			const configures = CONFIG_FLAGS.some((flag) => flag in args.flags);
			if (scope !== undefined && !configures) return pinScope(ctx.cwd, scope);
			return failure(
				`${path} already exists. Pass --force to overwrite it, or --scope <uri> alone to pin this directory's scope.`,
			);
		}
		const built = buildConfig({
			actor: flagString(args, "actor") ?? defaultActor(),
			deviceId: flagString(args, "device") ?? defaultDeviceId(),
			syncUrl: flagString(args, "sync-url"),
			syncToken: flagString(args, "sync-token"),
			accessClientId: flagString(args, "access-client-id"),
			accessClientSecret: flagString(args, "access-client-secret"),
			dbPath: flagString(args, "db-path"),
			tablePrefix: flagString(args, "table-prefix"),
		});
		if (!built.ok) return failure(built.error);

		const saved = saveConfig(ctx.home, built.value);
		if (!saved.ok) return failure(saved.error);
		const location = databaseLocation(ctx.home, built.value);
		const configured = configureRuntime(
			built.value,
			built.value.actor,
			location,
		);
		if (!configured.ok) return failure(configured.error);
		const initialized = await Planner.init(location.basePath);
		if (!initialized.ok) return failure(initialized.error);

		if (scope !== undefined) {
			const wrote = writeDirectoryScope(ctx.cwd, scope);
			if (!wrote.ok) return failure(wrote.error);
		}

		const config = built.value;
		return success(
			{
				home: ctx.home,
				config: {
					...config,
					sync: {
						...config.sync,
						token: config.sync.token ? "***" : undefined,
						headers: config.sync.headers
							? { ...config.sync.headers, "CF-Access-Client-Secret": "***" }
							: undefined,
					},
				},
				scope,
			},
			[
				`✓ Initialized ${ctx.home}`,
				`  actor:  ${config.actor}`,
				`  device: ${config.deviceId}`,
				`  sync:   ${config.sync.enabled ? config.sync.url : "disabled (pass --sync-url and --sync-token)"}`,
				`  access: ${config.sync.headers ? "service token headers set" : "none"}`,
				`  db:     ${location.basePath}/${location.dbName}${location.tablePrefix ? ` (tables ${location.tablePrefix}*)` : ""}`,
				...(scope ? [`  scope:  ${scope} (written to ./${SCOPE_FILE})`] : []),
				"Next: `kabane mcp install` gives Claude Code, Codex and Gemini this tracker over MCP.",
			].join("\n"),
		);
	},
};
