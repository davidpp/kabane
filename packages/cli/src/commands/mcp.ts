import type { Command } from "../context";
import type { Outcome } from "../output";

/** Replaced by the stdio server from `@cabane/core`'s `mcp/server.ts` once JCAB-7 merges. */
const pending: Outcome = {
	exitCode: 2,
	json: { error: "not yet available", lands: "JCAB-7" },
	text: "The stdio MCP server lands with JCAB-7 (core/mcp/server.ts). Until then, drive the CLI directly.",
};

export const mcp: Command = {
	name: "mcp",
	summary: "Serve this device's tracker over MCP on stdio (lands with JCAB-7)",
	usage: "cabane mcp",
	standalone: true,
	run: async () => pending,
};
