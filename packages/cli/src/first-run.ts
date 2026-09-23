/**
 * Bare `cabane` in a terminal: the board, after the setup screen when this
 * device has no config yet. The screen lives in `@cabane/board` and cannot see
 * the CLI's config schema or the MCP installer, so this module hands it all of
 * that as deps: the defaults to prefill, the detected harnesses, `save` (which
 * builds the config through `init`'s `buildConfig`) and `install`.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { type SetupDeps, type SetupPlan, startSetup } from "@cabane/board";
import { err, ok } from "@cabane/core";
import { detectScope } from "@cabane/core/scope";
import { parseArgs } from "./args";
import { board } from "./commands/board";
import { buildConfig } from "./commands/init";
import { McpInstall } from "./commands/mcp-install";
import {
	configPath,
	defaultDeviceId,
	saveConfig,
	writeDirectoryScope,
} from "./config";
import { openContext } from "./context";
import { McpClients } from "./mcp-clients";
import { failure, type Outcome, success } from "./output";

/** What setup needs from the MCP installer: which harnesses are here, and wiring them. */
export type Installer = {
	detect: () => Promise<SetupPlan.Harness[]>;
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
};

const LABELS: Record<McpClients.Id, string> = {
	claude: "Claude Code",
	codex: "Codex",
	gemini: "Gemini CLI",
};

// `replaced` cannot happen without `--force`, which setup never passes; it reads as installed.
export const outcomeOf = (
	report: McpInstall.Report,
): SetupPlan.InstallOutcome => {
	const id = report.harness;
	switch (report.status) {
		case "installed":
		case "replaced":
			return {
				id,
				status: "installed",
				message: `as ${McpClients.actorFor(id)}`,
			};
		case "present":
			return { id, status: "already" };
		case "missing":
			return { id, status: "failed", message: "not on PATH" };
		case "failed":
			return { id, status: "failed", message: report.error };
	}
};

/** `cabane mcp install`'s detection and registration, reported the way the screen shows them. */
const mcpInstaller: Installer = {
	detect: async () =>
		McpInstall.detect().map((id) => ({ id, label: LABELS[id] })),
	install: async (ids) =>
		(await McpInstall.run(ids.filter(McpClients.isId))).map(outcomeOf),
};

const repoOf = async (
	home: string,
	cwd: string,
): Promise<SetupPlan.Repo | null> => {
	// No extensions: a pin names the project, never the branch it was set up on.
	const detected = await detectScope(cwd, { home, detectExtensions: false });
	return detected
		? { root: detected.root, scopeId: detected.scopeId, name: detected.name }
		: null;
};

export const setupDeps = async (
	home: string,
	cwd: string,
	installer: Installer = mcpInstaller,
): Promise<SetupDeps> => ({
	defaults: {
		name: userInfo().username,
		device: defaultDeviceId(),
		harnesses: await installer.detect(),
		repo: await repoOf(home, cwd),
	},
	save: async (plan) => {
		// The screen only opens without a config; this holds that if one appeared since.
		const path = configPath(home);
		if (existsSync(path)) return err(new Error(`${path} already exists`));
		const config = buildConfig({ actor: plan.actor, deviceId: plan.deviceId });
		if (!config.ok) return config;
		const saved = saveConfig(home, config.value);
		if (!saved.ok) return saved;
		if (plan.pin) {
			const pinned = writeDirectoryScope(plan.pin.root, plan.pin.scopeId);
			if (!pinned.ok) return pinned;
		}
		return ok(saved.value);
	},
	install: installer.install,
});

export const openTui = async (
	home: string,
	cwd: string,
	installer?: Installer,
): Promise<Outcome> => {
	if (!existsSync(configPath(home))) {
		const completed = await startSetup(await setupDeps(home, cwd, installer));
		if (!completed) return success({ setup: "cancelled" }, "");
	}
	const args = parseArgs([]);
	const ctx = await openContext(home, cwd, args);
	if (!ctx.ok) return failure(ctx.error);
	return board.run(args, ctx.value);
};
