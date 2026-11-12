import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Planner, type Result } from "@cabane/core";
import { failure, flagBool, flagString, success } from "@cabane/extension";
import {
	type Config,
	ConfigSchema,
	configPath,
	DB_NAME,
	defaultActor,
	defaultDeviceId,
	SCOPE_FILE,
	saveConfig,
	writeDirectoryScope,
	writeLocalScope,
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

/** Everything a device's config is made of, as `init`'s flags or the setup screen give it. */
export type ConfigInput = {
	actor: string;
	deviceId: string;
	syncUrl?: string;
	syncToken?: string;
	accessClientId?: string;
	accessClientSecret?: string;
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
] as const;

/**
 * `--scope` pins the project's scope, since detection writes nothing in a repo: for you only,
 * under KABANE_HOME, or with `--shared` in the repo's `.kabane/scope` for everyone who clones it.
 */
const writePin = async (
	home: string,
	cwd: string,
	scope: string | undefined,
	shared: boolean,
): Promise<Result<{ pin: string; where: string } | undefined>> => {
	if (scope === undefined) return ok(undefined);
	if (shared) {
		const wrote = writeDirectoryScope(cwd, scope);
		return wrote.ok
			? ok({ pin: wrote.value, where: `./${SCOPE_FILE}, shared with the repo` })
			: wrote;
	}
	const wrote = await writeLocalScope(home, cwd, scope);
	return wrote.ok
		? ok({
				pin: wrote.value.path,
				where: `${wrote.value.path}, for ${wrote.value.root} on this device only`,
			})
		: wrote;
};

/** A device that already has a config pins with `--scope` alone, so pinning never costs the config a rewrite. */
const pinScope = async (
	home: string,
	cwd: string,
	scope: string,
	shared: boolean,
) => {
	const wrote = await writePin(home, cwd, scope, shared);
	if (!wrote.ok) return failure(wrote.error);
	return success(
		{ scope, pin: wrote.value?.pin },
		`✓ Pinned scope ${scope} in ${wrote.value?.where}`,
	);
};

export const init: Command = {
	name: "init",
	summary: "Create KABANE_HOME/config.json and the database",
	usage:
		"kabane init [--actor <uri>] [--device <id>] [--sync-url <url>] [--sync-token <token>] [--access-client-id <id> --access-client-secret <secret>] [--scope <uri> [--shared]] [--force]",
	standalone: true,
	run: async (args, ctx) => {
		const path = configPath(ctx.home);
		const scope = flagString(args, "scope");
		const shared = flagBool(args, "shared");
		if (existsSync(path) && !flagBool(args, "force")) {
			const configures = CONFIG_FLAGS.some((flag) => flag in args.flags);
			if (scope !== undefined && !configures)
				return pinScope(ctx.home, ctx.cwd, scope, shared);
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
		});
		if (!built.ok) return failure(built.error);
		// Before the config, so a pin refused outside a project leaves the device as it was.
		const pinned = await writePin(ctx.home, ctx.cwd, scope, shared);
		if (!pinned.ok) return failure(pinned.error);

		const saved = saveConfig(ctx.home, built.value);
		if (!saved.ok) return failure(saved.error);
		const configured = configureRuntime(built.value, built.value.actor);
		if (!configured.ok) return failure(configured.error);
		const initialized = await Planner.init(ctx.home);
		if (!initialized.ok) return failure(initialized.error);

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
				`  db:     ${join(ctx.home, DB_NAME)}`,
				...(pinned.value
					? [`  scope:  ${scope} (written to ${pinned.value.where})`]
					: []),
				"Next: `kabane mcp install` gives Claude Code, Codex and Gemini this tracker over MCP.",
			].join("\n"),
		);
	},
};
