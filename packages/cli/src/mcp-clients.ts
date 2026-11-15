import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";

/**
 * What each coding harness needs to register this device's MCP server: the
 * binary to look for, the argv that adds, finds and removes the `kabane`
 * entry, where its config file keeps that entry, the config snippet a human
 * pastes instead, and the project file it reads its instructions from. One
 * table, so the install and the printed snippets cannot drift apart. Nothing
 * here spawns: a harness's own `mcp get` health-checks the server, starting it.
 */
export namespace McpClients {
	/**
	 * The same ids as `Harnesses.IDS` in `@cabane/acp`, kept as a literal
	 * because importing that package loads the ACP SDK on every CLI start. A
	 * test asserts the two lists match.
	 */
	export const IDS = ["claude", "codex", "gemini"] as const;
	export type Id = (typeof IDS)[number];

	export const SERVER_NAME = "kabane";

	/** How a harness spawns the server: an absolute command and its args. */
	const LaunchSchema = z.object({
		command: z.string(),
		args: z.array(z.string()).default([]),
	});
	export type Launch = z.infer<typeof LaunchSchema>;

	/** What a harness's own `mcp get`/`list` printed. */
	export type Probe = { code: number; out: string; err: string };

	type Entry = {
		/** The binary on PATH that says the harness is installed. */
		binary: string;
		add: (launch: Launch, scope?: "user" | "local") => string[];
		find: string[];
		isPresent: (probe: Probe) => boolean;
		remove: string[];
		removeScoped?: (scope: "user" | "local") => string[];
		snippet: (launch: Launch) => Snippet;
		/** The file at a project root this harness reads as its instructions. */
		instructionFile: string;
	};

	export type Snippet = { title: string; text: string };

	/** Where a harness's config lives: the user's home, the environment, and the project, if any. */
	export type Where = {
		home: string;
		env: NodeJS.ProcessEnv;
		projectRoot?: string;
	};

	/** A `kabane` entry found in a harness config file, and which file and key held it. */
	type Registration = { at: string; launch: Launch; scope?: "user" | "local" };

	const ConfigSchema = z.record(z.unknown());

	// JSONC, because Gemini's settings.json may carry comments; a plain JSON file parses the same.
	const readConfig = (
		path: string,
		parse: (text: string) => unknown,
	): Result<Record<string, unknown> | undefined> => {
		if (!existsSync(path)) return ok(undefined);
		const parsed = trySync(() => parse(readFileSync(path, "utf8")));
		if (!parsed.ok) return err(new Error(`${path}: ${parsed.error.message}`));
		const config = ConfigSchema.safeParse(parsed.value);
		return config.success
			? ok(config.data)
			: err(new Error(`${path}: expected an object`));
	};

	// An entry without a command (an HTTP server) is not one `mcp install` writes.
	const serverIn = (servers: unknown, at: string): Registration[] => {
		const map = ConfigSchema.safeParse(servers);
		if (!map.success) return [];
		const launch = LaunchSchema.safeParse(map.data[SERVER_NAME]);
		return launch.success ? [{ at, launch: launch.data }] : [];
	};

	// User scope, then the project's local scope, which Claude keys by the project's path.
	const claudeRegistrations = (where: Where): Result<Registration[]> => {
		const path = join(where.home, ".claude.json");
		const config = readConfig(path, Bun.JSONC.parse);
		if (!config.ok || config.value === undefined)
			return config.ok ? ok([]) : config;
		const found: Registration[] = serverIn(
			config.value.mcpServers,
			`${path} mcpServers`,
		).map((registration) => ({ ...registration, scope: "user" }));
		const projects = ConfigSchema.safeParse(config.value.projects);
		if (where.projectRoot !== undefined && projects.success) {
			const project = ConfigSchema.safeParse(projects.data[where.projectRoot]);
			if (project.success)
				found.push(
					...serverIn(
						project.data.mcpServers,
						`${path} projects["${where.projectRoot}"].mcpServers`,
					).map((registration): Registration => ({
						...registration,
						scope: "local",
					})),
				);
		}
		return ok(found);
	};

	const codexRegistrations = (where: Where): Result<Registration[]> => {
		const path = join(
			where.env.CODEX_HOME || join(where.home, ".codex"),
			"config.toml",
		);
		const config = readConfig(path, Bun.TOML.parse);
		if (!config.ok || config.value === undefined)
			return config.ok ? ok([]) : config;
		return ok(serverIn(config.value.mcp_servers, `${path} [mcp_servers]`));
	};

	const geminiRegistrations = (where: Where): Result<Registration[]> => {
		const path = join(where.home, ".gemini", "settings.json");
		const config = readConfig(path, Bun.JSONC.parse);
		if (!config.ok || config.value === undefined)
			return config.ok ? ok([]) : config;
		return ok(serverIn(config.value.mcpServers, `${path} mcpServers`));
	};

	const REGISTRATIONS: Record<Id, (where: Where) => Result<Registration[]>> = {
		claude: claudeRegistrations,
		codex: codexRegistrations,
		gemini: geminiRegistrations,
	};

	/** The `kabane` entries a harness's config files hold, read without spawning the harness. */
	export const registrations = (id: Id, where: Where): Result<Registration[]> =>
		REGISTRATIONS[id](where);

	export const sameLaunch = (a: Launch, b: Launch): boolean =>
		isDeepStrictEqual(a, b);

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
			add: (launch, scope = "user") => [
				"claude",
				"mcp",
				"add",
				"-s",
				scope,
				SERVER_NAME,
				"--",
				launch.command,
				...launch.args,
			],
			find: ["claude", "mcp", "get", SERVER_NAME],
			isPresent: (probe) => probe.code === 0,
			// A fallback for entries not represented by the launch schema.
			remove: ["claude", "mcp", "remove", SERVER_NAME],
			removeScoped: (scope) => [
				"claude",
				"mcp",
				"remove",
				"-s",
				scope,
				SERVER_NAME,
			],
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
