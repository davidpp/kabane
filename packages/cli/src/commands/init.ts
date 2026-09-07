import { existsSync } from "node:fs";
import { Planner } from "@cabane/core";
import { flagBool, flagString } from "../args";
import {
	ConfigSchema,
	configPath,
	defaultActor,
	defaultDeviceId,
	saveConfig,
} from "../config";
import { type Command, configureRuntime } from "../context";
import { failure, success } from "../output";

export const init: Command = {
	name: "init",
	summary: "Create CABANE_HOME/config.json and the database",
	usage:
		"cabane init [--actor <uri>] [--device <id>] [--sync-url <url>] [--sync-token <token>] [--force]",
	standalone: true,
	run: async (args, ctx) => {
		const path = configPath(ctx.home);
		if (existsSync(path) && !flagBool(args, "force")) {
			return failure(`${path} already exists. Pass --force to overwrite.`);
		}
		const url = flagString(args, "sync-url");
		const token = flagString(args, "sync-token");
		const parsed = ConfigSchema.safeParse({
			actor: flagString(args, "actor") ?? defaultActor(),
			deviceId: flagString(args, "device") ?? defaultDeviceId(),
			sync: {
				enabled: url !== undefined && token !== undefined,
				url,
				token,
				deviceId: flagString(args, "device") ?? defaultDeviceId(),
			},
		});
		if (!parsed.success) return failure(parsed.error.message);

		const saved = saveConfig(ctx.home, parsed.data);
		if (!saved.ok) return failure(saved.error);
		configureRuntime(parsed.data, parsed.data.actor);
		const initialized = await Planner.init(ctx.home);
		if (!initialized.ok) return failure(initialized.error);

		const config = parsed.data;
		return success(
			{
				home: ctx.home,
				config: {
					...config,
					sync: {
						...config.sync,
						token: config.sync.token ? "***" : undefined,
					},
				},
			},
			[
				`✓ Initialized ${ctx.home}`,
				`  actor:  ${config.actor}`,
				`  device: ${config.deviceId}`,
				`  sync:   ${config.sync.enabled ? config.sync.url : "disabled (pass --sync-url and --sync-token)"}`,
			].join("\n"),
		);
	},
};
