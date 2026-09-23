// Which coding harness to talk ACP to and how to launch it. Adapter versions are pinned so a
// board session behaves the same on every device; a user overrides the command when they run
// a harness from somewhere else (a local build, a wrapper script).
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
		// Only Claude has the pair: the other two adapters' variables are not documented here,
		// and guessing one would pin a model silently wrong.
		model?: { env: string; pinned: string };
	};

	const REGISTRY: Record<Id, Entry> = {
		claude: {
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp@0.76.0"],
			// The adapter reads ANTHROPIC_MODEL ahead of settings.json, and takes the picker's
			// aliases as well as full ids. The alias is the point: it tracks whatever Sonnet is
			// current instead of pinning a version that ages out of the list.
			model: { env: "ANTHROPIC_MODEL", pinned: "sonnet" },
		},
		codex: {
			command: "npx",
			args: ["-y", "@agentclientprotocol/codex-acp@1.11.0"],
		},
		gemini: { command: "gemini", args: ["--acp"] },
	};

	// Lets the user's harness hooks tell a board session from an interactive one.
	export const SESSION_ENV = { KABANE_SESSION: "1" };

	export const isId = (value: string): value is Id =>
		(IDS as readonly string[]).includes(value);

	// An overridden command drops the registry args too: they belong to the npx package,
	// not to whatever binary the user pointed at. The model rides in the env instead, so it
	// survives a command override — it is a property of the harness, not of the launcher.
	export const resolve = (id: Id, overrides: Overrides = {}): Launch => {
		const base = REGISTRY[id];
		const command = overrides.command ?? base.command;
		const args =
			overrides.args ?? (overrides.command === undefined ? base.args : []);
		const model = base.model
			? { [base.model.env]: overrides.model ?? base.model.pinned }
			: {};
		return { command, args: [...args], env: { ...SESSION_ENV, ...model } };
	};

	// Only the Claude adapter reads `_meta.systemPrompt` on `session/new`; the others get
	// their instructions through the first prompt.
	export const acceptsSystemPrompt = (id: Id): boolean => id === "claude";
}
