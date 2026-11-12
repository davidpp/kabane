/**
 * Device configuration: `KABANE_HOME/config.json`.
 *
 * `KABANE_HOME` defaults to `~/.kabane`. The database lives beside the config
 * as `kabane.db`. Nothing here touches the database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
	err,
	ok,
	type Result,
	SyncConfigSchema,
	TimeZoneSchema,
	toError,
	tryCatch,
	trySync,
} from "@cabane/core";
import { findProjectRoot, localPinPath, SCOPE_FILE } from "@cabane/core/scope";
import type { Extension } from "@cabane/extension";
import { z } from "zod";

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

const UpdatesConfigSchema = z.object({
	check: z
		.boolean()
		.optional()
		.describe(
			"Whether the board says when a newer kabane release is out (npm, checked daily); absent is true.",
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
	copilot: CopilotConfigSchema.optional().describe(
		"Board copilot settings; absent uses the default harness and pinned adapter.",
	),
	harness: HarnessConfigSchema.optional().describe(
		"Every harness session's mode; absent is auto (the harness's own auto mode).",
	),
	updates: UpdatesConfigSchema.optional().describe(
		"Release notices on the board; absent checks for one.",
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

const CONFIG_FILE = "config.json";
export const DB_NAME = "kabane.db";
export { SCOPE_FILE };

export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string =>
	env.KABANE_HOME && env.KABANE_HOME.length > 0
		? env.KABANE_HOME
		: join(homedir(), ".kabane");

export const configPath = (home: string): string => join(home, CONFIG_FILE);

export const defaultActor = (): string =>
	`cabane://actor/human/${userInfo().username}`;

export const defaultDeviceId = (): string =>
	hostname().split(".")[0] ?? "device";

export const isPlainObject = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Zod's messages without its issue JSON, the path first where there is one. */
export const describeIssues = (error: z.ZodError): string =>
	error.issues
		.map((issue) =>
			issue.path.length > 0
				? `${issue.path.join(".")}: ${issue.message}`
				: issue.message,
		)
		.join("; ");

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
	if (!raw.ok)
		return err(
			new Error(`Invalid config at ${path}: ${toError(raw.error).message}`),
		);
	const parsed = ConfigSchema.safeParse(raw.value);
	if (!parsed.success || !isPlainObject(raw.value)) {
		return err(
			new Error(
				`Invalid config at ${path}: ${!parsed.success ? describeIssues(parsed.error) : "expected an object"}`,
			),
		);
	}
	// A `db` block used to point kabane at another file. Ignoring one would open
	// an empty database beside the config, which reads as every task gone.
	if ("db" in raw.value) {
		return err(
			new Error(
				`Invalid config at ${path}: the \`db\` block is no longer supported. The database is always ${join(home, DB_NAME)}, with unprefixed tables; remove the block once that file holds your tasks.`,
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
		return err(
			new Error(`Invalid config at ${path}: ${describeIssues(parsed.error)}`),
		);
	const written = trySync(() => {
		mkdirSync(home, { recursive: true });
		// Write the input, not parsed.data: defaults stay absent and unknown keys survive.
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

const writePin = (path: string, scope: string): Result<string> => {
	const written = trySync(() => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${scope.trim()}\n`);
		return path;
	});
	return written.ok ? ok(written.value) : err(toError(written.error));
};

/**
 * `kabane init --scope --shared` pins the scope for a directory tree, in the repo, for everyone
 * who clones it. Reading it back is a step of `detectScope`'s cascade, so nothing here reads it.
 */
export const writeDirectoryScope = (
	cwd: string,
	scope: string,
): Result<string> => writePin(join(cwd, SCOPE_FILE), scope);

/**
 * `kabane init --scope` pins the scope of the project `cwd` is in, for you only, under
 * KABANE_HOME: nothing lands in the repo. Outside a project there is no root to key it by.
 */
export const writeLocalScope = async (
	home: string,
	cwd: string,
	scope: string,
): Promise<Result<{ root: string; path: string }>> => {
	const root = await tryCatch(() => findProjectRoot(cwd, home));
	if (!root.ok) return root;
	if (!root.value)
		return err(
			new Error(
				`${cwd} is in no project, so there is nothing to pin. Pass --shared to mark this directory with ./${SCOPE_FILE}.`,
			),
		);
	const projectRoot = root.value;
	const path = await tryCatch(() => localPinPath(home, projectRoot));
	if (!path.ok) return path;
	const wrote = writePin(path.value, scope);
	return wrote.ok ? ok({ root: projectRoot, path: wrote.value }) : wrote;
};

/** Human authors comment as `human`; agent actor URIs comment as `ai`. */
export const authorTypeOf = (actor: string): "human" | "ai" =>
	actor.startsWith("cabane://actor/agent/") ? "ai" : "human";
