import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotInstructions, Harnesses } from "@kabane/acp";
import { McpClients } from "./mcp-clients";

const LAUNCHER = {
	command: "/opt/bun/bin/bun",
	args: ["/home/me/cabane/packages/cli/index.ts"],
};

describe("McpClients", () => {
	it("names the same harnesses as the ACP registry", () => {
		expect([...McpClients.IDS]).toEqual([...Harnesses.IDS]);
	});

	// codex-acp drops a session server whose name the harness config already has, so a session
	// server named like the installed one would be silently replaced by the human's own.
	it("installs under a name no kabane-launched session uses", () => {
		expect(McpClients.SERVER_NAME).not.toBe(CopilotInstructions.SERVER_NAME);
	});

	it("serves as the harness's own agent actor", () => {
		expect(McpClients.launchFor(LAUNCHER, "codex")).toEqual({
			command: "/opt/bun/bin/bun",
			args: [
				"/home/me/cabane/packages/cli/index.ts",
				"mcp",
				"--as",
				"kabane://actor/agent/codex",
			],
		});
	});

	it("adds at user scope, the launch after the name", () => {
		const launch = McpClients.launchFor(LAUNCHER, "claude");
		expect(McpClients.entry("claude").add(launch)).toEqual([
			"claude",
			"mcp",
			"add",
			"-s",
			"user",
			"kabane",
			"--",
			launch.command,
			...launch.args,
		]);
		expect(McpClients.entry("codex").add(launch).slice(0, 5)).toEqual([
			"codex",
			"mcp",
			"add",
			"kabane",
			"--",
		]);
		// Gemini takes the command positionally; a `--` would become the command.
		expect(McpClients.entry("gemini").add(launch).slice(0, 7)).toEqual([
			"gemini",
			"mcp",
			"add",
			"-s",
			"user",
			"kabane",
			launch.command,
		]);
	});

	it("reads presence off get's exit code, and off gemini's list lines", () => {
		expect(
			McpClients.entry("claude").isPresent({
				code: 0,
				out: "kabane:",
				err: "",
			}),
		).toBe(true);
		expect(
			McpClients.entry("codex").isPresent({ code: 1, out: "", err: "" }),
		).toBe(false);
		const gemini = McpClients.entry("gemini");
		const listed = [
			"Configured MCP servers:",
			"",
			"✓ nanobanana (from nanobanana): node index.js (stdio) - Connected",
			"✓ kabane: /opt/bun/bin/bun index.ts mcp (stdio) - Connected",
		].join("\n");
		expect(gemini.isPresent({ code: 0, out: "", err: listed })).toBe(true);
		expect(
			gemini.isPresent({
				code: 0,
				out: "",
				err: "✓ kabane-hub: https://x/mcp (http) - Connected",
			}),
		).toBe(false);
	});

	it("prints each harness's own config shape from the same launch", () => {
		const claude = JSON.parse(McpClients.snippetFor("claude", LAUNCHER).text);
		expect(claude.mcpServers.kabane.command).toBe("/opt/bun/bin/bun");
		expect(claude.mcpServers.kabane.args.at(-1)).toBe(
			"kabane://actor/agent/claude",
		);

		expect(McpClients.snippetFor("codex", LAUNCHER).text).toBe(
			[
				"[mcp_servers.kabane]",
				'command = "/opt/bun/bin/bun"',
				'args = ["/home/me/cabane/packages/cli/index.ts", "mcp", "--as", "kabane://actor/agent/codex"]',
			].join("\n"),
		);

		const gemini = JSON.parse(McpClients.snippetFor("gemini", LAUNCHER).text);
		expect(gemini.mcpServers.kabane.args.at(-1)).toBe(
			"kabane://actor/agent/gemini",
		);
	});

	it("leaves the generic client's actor for the human to name", () => {
		const generic = JSON.parse(McpClients.genericSnippet(LAUNCHER).text);
		expect(generic).toEqual({
			command: "/opt/bun/bin/bun",
			args: [
				"/home/me/cabane/packages/cli/index.ts",
				"mcp",
				"--as",
				"kabane://actor/agent/<client>",
			],
		});
	});
});

describe("McpClients.registrations", () => {
	const withHome = (run: (home: string) => void) => {
		const home = mkdtempSync(join(tmpdir(), "mcp-clients-"));
		try {
			run(home);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	};

	it("finds nothing without config files", () =>
		withHome((home) => {
			for (const id of McpClients.IDS)
				expect(McpClients.registrations(id, { home, env: {} })).toEqual({
					ok: true,
					value: [],
				});
		}));

	it("skips an entry with no command, such as an HTTP server", () =>
		withHome((home) => {
			mkdirSync(join(home, ".gemini"));
			writeFileSync(
				join(home, ".gemini/settings.json"),
				JSON.stringify({ mcpServers: { kabane: { httpUrl: "https://hub" } } }),
			);
			expect(McpClients.registrations("gemini", { home, env: {} })).toEqual({
				ok: true,
				value: [],
			});
		}));

	it("does not invent a launch by discarding invalid args", () =>
		withHome((home) => {
			writeFileSync(
				join(home, ".claude.json"),
				JSON.stringify({
					mcpServers: { kabane: { command: "kabane", args: ["mcp", 42] } },
				}),
			);
			expect(McpClients.registrations("claude", { home, env: {} })).toEqual({
				ok: true,
				value: [],
			});
		}));

	it("names the file it could not parse", () =>
		withHome((home) => {
			mkdirSync(join(home, ".codex"));
			writeFileSync(join(home, ".codex/config.toml"), "[mcp_servers.kabane");
			const read = McpClients.registrations("codex", { home, env: {} });
			expect(read.ok).toBe(false);
			if (!read.ok)
				expect(read.error.message).toContain(join(home, ".codex/config.toml"));
		}));
});
