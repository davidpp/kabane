/**
 * What each coding harness needs to register this device's MCP server: the
 * binary to look for, the argv that adds, finds and removes the `cabane`
 * entry, the config snippet a human pastes instead, and the project file it
 * reads its instructions from. One table, so the install and the printed
 * snippets cannot drift apart. Pure: nothing here spawns.
 */
export namespace McpClients {
	/**
	 * The same ids as `Harnesses.IDS` in `@cabane/acp`, kept as a literal
	 * because importing that package loads the ACP SDK on every CLI start. A
	 * test asserts the two lists match.
	 */
	export const IDS = ["claude", "codex", "gemini"] as const;
	export type Id = (typeof IDS)[number];

	export const SERVER_NAME = "cabane";

	/** How a harness spawns the server: an absolute command and its args. */
	export type Launch = { command: string; args: string[] };

	/** What a harness's own `mcp get`/`list` printed. */
	export type Probe = { code: number; out: string; err: string };

	type Entry = {
		/** The binary on PATH that says the harness is installed. */
		binary: string;
		add: (launch: Launch) => string[];
		find: string[];
		isPresent: (probe: Probe) => boolean;
		remove: string[];
		snippet: (launch: Launch) => Snippet;
		/** The file at a project root this harness reads as its instructions. */
		instructionFile: string;
	};

	export type Snippet = { title: string; text: string };

	const json = (value: unknown): string => JSON.stringify(value, null, 2);

	const mcpServersJson = (launch: Launch): string =>
		json({
			mcpServers: {
				[SERVER_NAME]: { command: launch.command, args: launch.args },
			},
		});

	// A TOML basic string and a JSON string escape the same way.
	const toml = (launch: Launch): string =>
		[
			`[mcp_servers.${SERVER_NAME}]`,
			`command = ${JSON.stringify(launch.command)}`,
			`args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
		].join("\n");

	// Gemini has no `mcp get`; its list prints one `✓ <name>: <command> ...` line per server,
	// on stderr.
	const geminiListed = (probe: Probe): boolean =>
		`${probe.out}\n${probe.err}`
			.split("\n")
			.some((line) => line.trim().split(/\s+/)[1] === `${SERVER_NAME}:`);

	const TABLE: Record<Id, Entry> = {
		claude: {
			binary: "claude",
			add: (launch) => [
				"claude",
				"mcp",
				"add",
				"-s",
				"user",
				SERVER_NAME,
				"--",
				launch.command,
				...launch.args,
			],
			find: ["claude", "mcp", "get", SERVER_NAME],
			isPresent: (probe) => probe.code === 0,
			// No scope: removes the entry from whichever scope `get` found it in.
			remove: ["claude", "mcp", "remove", SERVER_NAME],
			snippet: (launch) => ({
				title: "Claude Code: .mcp.json at a project root",
				text: mcpServersJson(launch),
			}),
			instructionFile: "CLAUDE.md",
		},
		codex: {
			binary: "codex",
			add: (launch) => [
				"codex",
				"mcp",
				"add",
				SERVER_NAME,
				"--",
				launch.command,
				...launch.args,
			],
			find: ["codex", "mcp", "get", SERVER_NAME],
			isPresent: (probe) => probe.code === 0,
			remove: ["codex", "mcp", "remove", SERVER_NAME],
			snippet: (launch) => ({
				title: "Codex: ~/.codex/config.toml",
				text: toml(launch),
			}),
			instructionFile: "AGENTS.md",
		},
		gemini: {
			binary: "gemini",
			add: (launch) => [
				"gemini",
				"mcp",
				"add",
				"-s",
				"user",
				SERVER_NAME,
				launch.command,
				...launch.args,
			],
			find: ["gemini", "mcp", "list"],
			isPresent: (probe) => probe.code === 0 && geminiListed(probe),
			remove: ["gemini", "mcp", "remove", "-s", "user", SERVER_NAME],
			snippet: (launch) => ({
				title: "Gemini CLI: ~/.gemini/settings.json",
				text: mcpServersJson(launch),
			}),
			instructionFile: "GEMINI.md",
		},
	};

	export const isId = (value: string): value is Id =>
		(IDS as readonly string[]).includes(value);

	export const entry = (id: Id): Entry => TABLE[id];

	/** Writes through a harness are stamped with the harness's own agent actor. */
	export const actorFor = (client: string): string =>
		`cabane://actor/agent/${client}`;

	export const launchFor = (launcher: Launch, client: string): Launch => ({
		command: launcher.command,
		args: [...launcher.args, "mcp", "--as", actorFor(client)],
	});

	/**
	 * The entry for a client with no registration CLI (Cursor, Windsurf, ...).
	 * `<client>` stays literal: guessing a name would stamp writes with the
	 * wrong actor, silently.
	 */
	export const genericSnippet = (launcher: Launch): Snippet => {
		const launch = launchFor(launcher, "<client>");
		return {
			title: `Any other client (Cursor, Windsurf, ...): the "${SERVER_NAME}" entry of its MCP server map; replace <client>`,
			text: json({ command: launch.command, args: launch.args }),
		};
	};

	export const snippetFor = (id: Id, launcher: Launch): Snippet =>
		TABLE[id].snippet(launchFor(launcher, id));
}
