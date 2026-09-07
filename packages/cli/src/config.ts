/**
 * Device configuration: `CABANE_HOME/config.json`.
 *
 * `CABANE_HOME` defaults to `~/.cabane`. The database lives beside the config
 * as `cabane.db` with plain table names. Nothing here touches the database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
	err,
	ok,
	type Result,
	SyncConfigSchema,
	toError,
	trySync,
} from "@cabane/core";
import { z } from "zod";

export const ConfigSchema = z.object({
	/** Actor URI stamped on what this device writes. */
	actor: z.string().min(1),
	/** Seeds the sync device identity on first arming; write-once afterwards. */
	deviceId: z.string().min(1),
	sync: SyncConfigSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = "config.json";
export const DB_NAME = "cabane.db";
export const SCOPE_FILE = join(".cabane", "scope");

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string =>
	env.CABANE_HOME && env.CABANE_HOME.length > 0
		? env.CABANE_HOME
		: join(homedir(), ".cabane");

export const configPath = (home: string): string => join(home, CONFIG_FILE);

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
 * The per-directory scope default: the trimmed content of `./.cabane/scope`
 * when present. No git resolution here; that is the host's business.
 */
export const directoryScope = (cwd: string): string | undefined => {
	const path = join(cwd, SCOPE_FILE);
	if (!existsSync(path)) return undefined;
	const value = readFileSync(path, "utf8").trim();
	return value.length > 0 ? value : undefined;
};

/** `cabane init --scope` pins the directory default the rule above reads. */
export const writeDirectoryScope = (
	cwd: string,
	scope: string,
): Result<string> => {
	const path = join(cwd, SCOPE_FILE);
	const written = trySync(() => {
		mkdirSync(join(cwd, ".cabane"), { recursive: true });
		writeFileSync(path, `${scope.trim()}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

/** Human authors comment as `human`; agent actor URIs comment as `ai`. */
export const authorTypeOf = (actor: string): "human" | "ai" =>
	actor.startsWith("cabane://actor/agent/") ? "ai" : "human";
