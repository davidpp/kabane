/**
 * Bare `cabane` in a terminal: the board, after the setup screen when this
 * device has no config yet. The screen lives in `@cabane/board` and cannot see
 * the CLI's config schema or the MCP installer, so this module hands it all of
 * that as deps: the defaults to prefill, the detected harnesses, `save` (which
 * builds the config through `init`'s `buildConfig`), `install`, and
 * `fileFirstIssue`, which files the one issue that gets an agent working here.
 */

import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { type SetupDeps, type SetupPlan, startSetup } from "@cabane/board";
import { err, ok, Planner, type Result } from "@cabane/core";
import { parseArgs } from "./args";
import { board } from "./commands/board";
import { buildConfig } from "./commands/init";
import { McpInstall } from "./commands/mcp-install";
import { configPath, defaultDeviceId, saveConfig } from "./config";
import { detectProject, openContext, resolveScope } from "./context";
import { McpClients } from "./mcp-clients";
import { failure, type Outcome, success } from "./output";

/**
 * What setup needs from the MCP installer: which harnesses are here, whether detection was narrowed
 * by configuration (so an empty list means install is off, not that none are installed), and wiring them.
 */
export type Installer = {
	detect: () => Promise<SetupPlan.Harness[]>;
	narrowed: () => boolean;
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
};

const LABELS: Record<McpClients.Id, string> = {
	claude: "Claude Code",
	codex: "Codex",
	gemini: "Gemini CLI",
};

// A harness's stderr can run to warnings and a backtrace; its last line is usually the cause, and
// `cabane mcp install` still prints the whole of it.
const lastLine = (text: string): string =>
	text.trim().split("\n").at(-1)?.trim() ?? text;

// `replaced` cannot happen without `--force`, which setup never passes; it reads as installed.
// The agent's actor URI goes unsaid: it is jargon to a newcomer, and the guide lists it per harness.
export const outcomeOf = (
	report: McpInstall.Report,
): SetupPlan.InstallOutcome => {
	const id = report.harness;
	switch (report.status) {
		case "installed":
		case "replaced":
			return { id, status: "installed" };
		case "present":
			return { id, status: "already" };
		case "missing":
			return { id, status: "failed", message: "not on PATH" };
		case "failed":
			return { id, status: "failed", message: lastLine(report.error) };
	}
};

/** `cabane mcp install`'s detection and registration, reported the way the screen shows them. */
const mcpInstaller: Installer = {
	detect: async () =>
		McpInstall.detect().map((id) => ({ id, label: LABELS[id] })),
	narrowed: () => McpInstall.narrowed(),
	install: async (ids) =>
		(await McpInstall.run(ids.filter(McpClients.isId))).map(outcomeOf),
};

/**
 * The brief of the first issue. It asks for the step an agent needs before it uses cabane
 * unprompted, and it is worked the way the block says, so the agent's first pass through the
 * tracker is on the issue that teaches it the tracker. The block is the one getting-started.md
 * gives a human to paste by hand.
 */
export const firstIssueBrief = (instructionFile: string): string =>
	[
		`Setup registered cabane's MCP server in your harness. Agents use the tracker reliably only when the project says so, and this issue adds that: append the block below to \`${instructionFile}\` at the project root, creating the file if it is missing.`,
		"",
		"Work this issue the way the block says: set it `in_progress` first, then `cabane_comment` what you changed and `cabane_done` it.",
		"",
		"```markdown",
		"## Tracker",
		"",
		"Work is tracked in cabane (MCP server `cabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.",
		'- Before starting, `cabane_list` with `assignee` set to your name and `state: "next"`; read the task with `cabane_context`.',
		"- Set the task `in_progress` with `cabane_edit` before touching code. Never take a task that is already in progress.",
		"- When finished, `cabane_comment` what landed (files, commits, what is left), then `cabane_done`.",
		"- File new work you find with `cabane_add` instead of doing it unasked.",
		"```",
	].join("\n");

/**
 * Files the first issue in the project `cwd` sits in, assigned to `harness` and ready to take.
 * Runs after `save`, so the device has the config every write needs.
 */
const fileFirstIssue = async (
	home: string,
	cwd: string,
	harness: string,
): Promise<Result<SetupPlan.FirstIssue>> => {
	if (!McpClients.isId(harness))
		return err(new Error(`unknown harness ${harness}`));
	const args = parseArgs([]);
	const ctx = await openContext(home, cwd, args);
	if (!ctx.ok) return ctx;
	const scope = await resolveScope(args, ctx.value);
	if (!scope) return err(new Error("not inside a project"));
	const { instructionFile } = McpClients.entry(harness);
	const created = await Planner.addTask(ctx.value.store, {
		title: `Add cabane to ${instructionFile}`,
		description: firstIssueBrief(instructionFile),
		kind: "issue",
		state: "next",
		priority: "normal",
		scopeUri: scope.scopeUri,
		assignee: harness,
		tags: [],
		provenance: {
			source: "human",
			discoveredAt: new Date().toISOString(),
			discoveredBy: ctx.value.actor,
		},
	});
	if (!created.ok) return created;
	return ok({
		shortId: created.value.shortId ?? created.value.id,
		title: created.value.title,
	});
};

/** `/Users/alex/.cabane/config.json` as `~/.cabane/config.json`: the screen has 40 columns. */
export const tildePath = (path: string, home = homedir()): string =>
	path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

export const setupDeps = async (
	home: string,
	cwd: string,
	installer: Installer = mcpInstaller,
): Promise<SetupDeps> => {
	const harnesses = await installer.detect();
	const project = await detectProject(cwd, home);
	return {
		defaults: {
			name: userInfo().username,
			device: defaultDeviceId(),
			harnesses,
			installOff: harnesses.length === 0 && installer.narrowed(),
			configPath: tildePath(configPath(home)),
			project: project?.name,
		},
		save: async (plan) => {
			// The screen only opens without a config; this holds that if one appeared since.
			const path = configPath(home);
			if (existsSync(path)) return err(new Error(`${path} already exists`));
			const config = buildConfig({
				actor: plan.actor,
				deviceId: plan.deviceId,
			});
			if (!config.ok) return config;
			const saved = saveConfig(home, config.value);
			return saved.ok ? ok(tildePath(saved.value)) : saved;
		},
		install: installer.install,
		fileFirstIssue: (harness) => fileFirstIssue(home, cwd, harness),
	};
};

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
