/**
 * Bare `kabane` in a terminal: the board, after the setup screen when this
 * device has no config yet. The screen lives in `@kabane/board` and cannot see
 * the CLI's config schema or the MCP installer, so this module hands it all of
 * that as deps: the defaults to prefill, the detected harnesses, the extensions this install
 * ships, `save` (which builds the config through `init`'s `buildConfig`), `install`, `enable`
 * (which turns the ticked extensions on as `kabane config set extensions` does), and
 * `fileFirstIssue`, which files the one issue that gets an agent working here.
 */

import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { type SetupDeps, type SetupPlan, startSetup } from "@kabane/board";
import { err, ok, Planner, type Result } from "@kabane/core";
import { failure, type Outcome, parseArgs, success } from "@kabane/extension";
import { board } from "./commands/board";
import { buildConfig } from "./commands/init";
import { McpInstall } from "./commands/mcp-install";
import { configPath, defaultDeviceId, saveConfig } from "./config";
import { ConfigSettings } from "./config-settings";
import { detectProject, openContext, resolveScope } from "./context";
import { Extensions } from "./extensions";
import { McpClients } from "./mcp-clients";

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
// `kabane mcp install` still prints the whole of it.
const lastLine = (text: string): string =>
	text.trim().split("\n").at(-1)?.trim() ?? text;

// `replaced` cannot happen without `--force`, which setup never passes; it reads as installed.
// A stale entry is there all the same: `kabane doctor` reports what it launches.
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
		case "stale":
			return { id, status: "already" };
		case "missing":
			return { id, status: "failed", message: "not on PATH" };
		case "failed":
			return { id, status: "failed", message: lastLine(report.error) };
	}
};

/** `kabane mcp install`'s detection and registration, reported the way the screen shows them. */
const mcpInstaller: Installer = {
	detect: async () =>
		McpInstall.detect().map((id) => ({ id, label: LABELS[id] })),
	narrowed: () => McpInstall.narrowed(),
	install: async (ids) =>
		(await McpInstall.run(ids.filter(McpClients.isId))).map(outcomeOf),
};

/**
 * The section an instruction file needs before an agent uses kabane unprompted. getting-started.md
 * gives a human the same block to paste by hand, and `kabane doctor` compares a project's copy to it.
 */
export const TRACKER_BLOCK = [
	"## Tracker",
	"",
	"Work is tracked in kabane (MCP server `kabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.",
	'- Before starting, `kabane_list` with `assignee` set to your name, `state: "next"`, and `responseFormat: "concise"`. If no suitable task is on the page and `hasMore` is true, follow `nextCursor` with the same filters; only assert no work remains after `hasMore` is false. Read the chosen task with `kabane_context` and `responseFormat: "concise"`; consume every preceding chunk and continue with `nextCursor` until `selectedComplete`, `descriptionComplete`, and `humanSteeringComplete` are true before starting work. Use the same id/options; request any omitted required sections.',
	'- Set the task `in_progress` with `kabane_edit` and `responseFormat: "concise"` before touching code. Never take a task that is already in progress.',
	'- When finished, hand the task off with `kabane_handoff`: what landed, the evidence of what you checked, and what you did not verify. `kabane_comment` is for notes along the way. Check write results for errors before `kabane_done` with `responseFormat: "concise"`.',
	'- File new work you find with `kabane_add` and `responseFormat: "concise"` instead of doing it unasked. Use `kabane_get` for full own fields.',
].join("\n");

/**
 * The brief of the first issue. It asks for the step an agent needs before it uses kabane
 * unprompted, and it is worked the way the block says, so the agent's first pass through the
 * tracker is on the issue that teaches it the tracker.
 */
export const firstIssueBrief = (instructionFile: string): string =>
	[
		`Setup registered kabane's MCP server in your harness. Agents use the tracker reliably only when the project says so, and this issue adds that: append the block below to \`${instructionFile}\` at the project root, creating the file if it is missing.`,
		"",
		"Work this issue the way the block says: set it `in_progress` first, then hand it off with `kabane_handoff` saying what you changed and how you checked it; check write results for errors before `kabane_done`.",
		"",
		"```markdown",
		TRACKER_BLOCK,
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
		title: `Add kabane to ${instructionFile}`,
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

/** The extensions this install ships, each with what its manifest says it adds and to do first. */
export const offers = (root = Extensions.shippedRoot()): SetupPlan.Offer[] =>
	root === undefined
		? []
		: Extensions.shipped(root).map((name) => {
				const path = join(root, name);
				const description = Extensions.descriptionAt(path);
				const firstStep = Extensions.firstStepAt(path);
				return {
					name,
					...(description === undefined ? {} : { description }),
					...(firstStep === undefined ? {} : { firstStep }),
				};
			});

/**
 * Turns on the ticked extensions through the global layer, as `kabane config set extensions
 * <names> --layer global` does, which links each one this install ships. Runs after `save`: the
 * config it writes to is the one setup just created, so nothing else is in `extensions` yet.
 */
const enable = async (
	home: string,
	names: readonly string[],
): Promise<Result<void>> => {
	const changed = await ConfigSettings.set(
		home,
		{},
		"extensions",
		JSON.stringify(names),
		"global",
	);
	return changed.ok ? ok(undefined) : changed;
};

/** `/Users/alex/.kabane/config.json` as `~/.kabane/config.json`: the screen has 40 columns. */
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
			extensions: offers(),
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
		enable: (names) => enable(home, names),
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
