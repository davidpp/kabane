// Which coding harness to talk ACP to and how to launch it. Adapter versions are pinned so a
// board session behaves the same on every device; a user overrides the command when they run
// a harness from somewhere else (a local build, a wrapper script).
import { err, ok, type Result } from "@cabane/core";

export namespace Harnesses {
	export const IDS = ["claude", "codex", "gemini"] as const;
	export type Id = (typeof IDS)[number];

	export type Launch = {
		command: string;
		args: string[];
		// Added on top of the parent's environment, never replacing it.
		env: Record<string, string>;
	};

	export type Overrides = { command?: string; args?: string[]; model?: string };

	type Entry = {
		command: string;
		args: string[];
		// The env var this harness reads its model from, and what we pin it to. Board work is
		// triage and small edits against a planner, not the reasoning the frontier models are
		// for, so the default is the cheap one rather than whatever the human left in their
		// own settings — a config `model` overrides it with any name the harness accepts.
		// Only Claude has the pair: Gemini reads `GEMINI_MODEL` but no pin is chosen for it,
		// and codex-acp reads no model variable at all. That is why the loop does not use it: it
		// selects its model on the session's `model` config option (`AcpClient.selectModel`),
		// which both pinned adapters advertise.
		model?: { env: string; pinned: string };
		// The ACP session modes the adapter advertises on `session/new`: the one that asks
		// before every change (`manual`) and the harness's own auto mode, where the harness
		// decides which tool calls need a human. Ids as each pinned adapter sends them.
		modes?: Modes;
	};

	export type Modes = { manual: string; auto: string };

	const REGISTRY: Record<Id, Entry> = {
		claude: {
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"],
			// The adapter reads ANTHROPIC_MODEL ahead of settings.json, and takes the picker's
			// aliases as well as full ids. The alias is the point: it tracks whatever Sonnet is
			// current instead of pinning a version that ages out of the list.
			model: { env: "ANTHROPIC_MODEL", pinned: "sonnet" },
			// Advertised: `default` ("Manual", always ask), `acceptEdits`, `plan`, `auto` ("Claude
			// handles permission decisions") and `bypassPermissions`, which kabane never selects.
			modes: { manual: "default", auto: "auto" },
		},
		codex: {
			command: "npx",
			// 2.5.0 declares @openai/codex ^0.165, but CODEX_PATH runs the user's own CLI instead,
			// and it was checked live against an older one (codex-cli 0.163.0).
			args: ["-y", "@agentclientprotocol/codex-acp@2.5.0"],
			// Advertised: `read-only` (a read-only sandbox that asks before every edit),
			// `workspace-write`, `agent` ("Auto review": asks only for actions it detects as
			// unsafe, and the mode a session opens in) and `agent-full-access`, never selected.
			modes: { manual: "read-only", auto: "agent" },
		},
		// Gemini's modes are `default`, `autoEdit`, `yolo` and `plan`; none is "the harness
		// decides", so no auto mode is named and its sessions stay on whatever they start in.
		gemini: { command: "gemini", args: ["--acp"] },
	};

	/**
	 * The mode a session is asked to start in. `auto` is the harness's own auto mode, selected
	 * when the session opens in its manual one; `default` selects nothing, so the session runs in
	 * whatever mode the harness and the user's settings start it in.
	 */
	export const MODES = ["auto", "default"] as const;
	export type Mode = (typeof MODES)[number];

	export const modes = (id: Id): Modes | undefined => REGISTRY[id].modes;

	// Lets the user's harness hooks tell a board session from an interactive one.
	export const SESSION_ENV = { KABANE_SESSION: "1" };

	// Who launches a session and on what terms. The board copilot pins the cheap model and
	// marks its sessions with SESSION_ENV; another launcher (the loop) pins nothing here, picks
	// its model once the session is open, and carries its own marker, plus whatever else its env
	// needs.
	export type Profile = {
		/** Pin the registry's model when no override names one. */
		pinModel: boolean;
		/** Added to the launch env, on top of the parent's. */
		env: Record<string, string>;
	};

	export const COPILOT: Profile = { pinModel: true, env: SESSION_ENV };

	export const isId = (value: string): value is Id =>
		(IDS as readonly string[]).includes(value);

	// An overridden command drops the registry args too: they belong to the npx package,
	// not to whatever binary the user pointed at. The model rides in the env instead, so it
	// survives a command override — it is a property of the harness, not of the launcher.
	export const resolve = (
		id: Id,
		overrides: Overrides = {},
		profile: Profile = COPILOT,
	): Launch => {
		const base = REGISTRY[id];
		const command = overrides.command ?? base.command;
		const args =
			overrides.args ?? (overrides.command === undefined ? base.args : []);
		const chosen =
			overrides.model ?? (profile.pinModel ? base.model?.pinned : undefined);
		const model =
			base.model && chosen !== undefined ? { [base.model.env]: chosen } : {};
		return { command, args: [...args], env: { ...profile.env, ...model } };
	};

	// The CLI each adapter drives, and the variable that points the adapter at an installed
	// copy instead of the one it bundles (claude-agent-acp: CLAUDE_CODE_EXECUTABLE, else the
	// Agent SDK's bundled binary; codex-acp: CODEX_PATH, else its bundled @openai/codex).
	// Gemini has no adapter: `gemini --acp`, or the user's command override, is the CLI itself.
	const CLI: Partial<Record<Id, { bin: string; env: string }>> = {
		claude: { bin: "claude", env: "CLAUDE_CODE_EXECUTABLE" },
		codex: { bin: "codex", env: "CODEX_PATH" },
	};

	/**
	 * The env that makes the adapter run the user's installed CLI, found on PATH, so its
	 * version, login and settings are the user's own. An error when it is not installed:
	 * falling back to a bundled copy would run a version the user never chose. Nothing when
	 * `env` (the one the session inherits) already sets the variable: the user chose that
	 * copy, and the spawn merge would otherwise overwrite it. Nothing, and no PATH lookup, for
	 * a harness without an adapter: its launch command is what runs, wherever it points.
	 */
	export const installedCli = (
		id: Id,
		env: Readonly<Record<string, string | undefined>> = process.env,
		which: (bin: string) => string | null = Bun.which,
	): Result<Record<string, string>> => {
		const cli = CLI[id];
		if (!cli) return ok({});
		// The user's own copy wins; naming it keeps the run's launch record honest.
		const own = env[cli.env];
		if (own) return ok({ [cli.env]: own });
		const path = which(cli.bin);
		if (path === null)
			return err(
				new Error(
					`${cli.bin} is not on PATH: install the ${id} CLI, put it on PATH, or set ${cli.env} to your copy, so sessions run your own CLI`,
				),
			);
		return ok({ [cli.env]: path });
	};

	// Only the Claude adapter reads `_meta.systemPrompt` on `session/new`; the others get
	// their instructions through the first prompt.
	export const acceptsSystemPrompt = (id: Id): boolean => id === "claude";
}
