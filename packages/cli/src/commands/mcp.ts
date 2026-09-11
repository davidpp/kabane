import { serveStdio } from "@cabane/core";
import { type Command, resolveScopeUri } from "../context";
import { success } from "../output";

/**
 * Serve this device's tracker over MCP on stdio. Same tool list as the hub;
 * here a write may omit `scopeUri` and fall back to the scope of the directory
 * the server was started in, because a device has a working directory and the
 * hub does not.
 *
 * Stdout is the wire, so nothing is printed before the server takes it, and
 * the outcome text is empty once it closes.
 */
export const mcp: Command = {
	name: "mcp",
	summary:
		"Serve this device's tracker over MCP on stdio (for Claude Code, Hermes, Codex)",
	usage: "cabane mcp [--as <actor-uri>]",
	run: async (args, ctx) => {
		await serveStdio(
			{
				basePath: ctx.store,
				actor: ctx.actor,
				defaultScope: await resolveScopeUri(args, ctx),
				scopeRequired: false,
			},
			{ name: "cabane" },
		);
		return success({ served: true }, "");
	},
};
