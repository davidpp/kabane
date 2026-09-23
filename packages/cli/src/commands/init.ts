import { existsSync } from "node:fs";
import { err, ok, Planner, type Result } from "@cabane/core";
import { flagBool, flagString } from "../args";
import {
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
import { failure, success } from "../output";

/**
 * The hub sits behind Cloudflare Access; a device passes the edge with a
 * service token carried as two headers on every push and pull. Both halves or
 * neither: one without the other is a typo, not a configuration.
 */
export const accessHeaders = (
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
 * existed keeps meaning `CABANE_HOME/cabane.db` with plain names. A Jake user
 * passes `--db-path ~/.jake/jake.db --table-prefix planner_` and shares Jake's
 * database instead of migrating.
 */
export const dbBlock = (
	path: string | undefined,
	tablePrefix: string | undefined,
): DbConfig | undefined =>
	path === undefined && tablePrefix === undefined
		? undefined
		: { path, tablePrefix };

export const init: Command = {
	name: "init",
	summary: "Create CABANE_HOME/config.json and the database",
	usage:
		"cabane init [--actor <uri>] [--device <id>] [--sync-url <url>] [--sync-token <token>] [--access-client-id <id> --access-client-secret <secret>] [--db-path <file> [--table-prefix <prefix>]] [--scope <uri>] [--force]",
	standalone: true,
	run: async (args, ctx) => {
		const path = configPath(ctx.home);
		if (existsSync(path) && !flagBool(args, "force")) {
			return failure(`${path} already exists. Pass --force to overwrite.`);
		}
		const url = flagString(args, "sync-url");
		const token = flagString(args, "sync-token");
		const headers = accessHeaders(
			flagString(args, "access-client-id"),
			flagString(args, "access-client-secret"),
		);
		if (!headers.ok) return failure(headers.error);
		const parsed = ConfigSchema.safeParse({
			actor: flagString(args, "actor") ?? defaultActor(),
			deviceId: flagString(args, "device") ?? defaultDeviceId(),
			sync: {
				enabled: url !== undefined && token !== undefined,
				url,
				token,
				headers: headers.value,
				deviceId: flagString(args, "device") ?? defaultDeviceId(),
			},
			db: dbBlock(
				flagString(args, "db-path"),
				flagString(args, "table-prefix"),
			),
		});
		if (!parsed.success) return failure(parsed.error.message);

		const saved = saveConfig(ctx.home, parsed.data);
		if (!saved.ok) return failure(saved.error);
		const location = databaseLocation(ctx.home, parsed.data);
		configureRuntime(parsed.data, parsed.data.actor, location);
		const initialized = await Planner.init(location.basePath);
		if (!initialized.ok) return failure(initialized.error);

		const scope = flagString(args, "scope");
		if (scope !== undefined) {
			const wrote = writeDirectoryScope(ctx.cwd, scope);
			if (!wrote.ok) return failure(wrote.error);
		}

		const config = parsed.data;
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
				"Next: `cabane mcp install` gives Claude Code, Codex and Gemini this tracker over MCP.",
			].join("\n"),
		);
	},
};
