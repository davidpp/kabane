import { existsSync } from "node:fs";
import { err, ok, Planner, type Result } from "@cabane/core";
import { flagBool, flagString } from "../args";
import {
	ConfigSchema,
	configPath,
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

export const init: Command = {
	name: "init",
	summary: "Create CABANE_HOME/config.json and the database",
	usage:
		"cabane init [--actor <uri>] [--device <id>] [--sync-url <url>] [--sync-token <token>] [--access-client-id <id> --access-client-secret <secret>] [--scope <uri>] [--force]",
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
		});
		if (!parsed.success) return failure(parsed.error.message);

		const saved = saveConfig(ctx.home, parsed.data);
		if (!saved.ok) return failure(saved.error);
		configureRuntime(parsed.data, parsed.data.actor);
		const initialized = await Planner.init(ctx.home);
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
				...(scope ? [`  scope:  ${scope} (written to ./${SCOPE_FILE})`] : []),
			].join("\n"),
		);
	},
};
