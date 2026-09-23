import { serveStdio } from "@cabane/core";
import { type Command, openContext, resolveScopeUri } from "../context";
import { failure, success } from "../output";
import { MCP_INSTALL_USAGE, mcpInstall } from "./mcp-install";

/**
 * Serve this device's tracker over MCP on stdio. Same tool list as the hub;
 * here a write may omit `scopeUri` and fall back to the scope of the directory
 * the server was started in, because a device has a working directory and the
 * hub does not.
 *
 * Stdout is the wire, so nothing is printed before the server takes it, and
 * the outcome text is empty once it closes.
 *
 * Standalone because `mcp install` registers the server in a harness and
 * needs no config; serving opens the context itself.
 */
export const mcp: Command = {
	name: "mcp",
	summary:
		"Serve this device's tracker over MCP on stdio; `mcp install` registers it in Claude Code, Codex, Gemini",
	usage: `cabane mcp [--as <actor-uri>]\n       ${MCP_INSTALL_USAGE}`,
	standalone: true,
	run: async (args, bare) => {
		if (args.positionals[0] === "install") return mcpInstall(args);
		const ctx = await openContext(bare.home, bare.cwd, args);
		if (!ctx.ok) return failure(ctx.error);
		await serveStdio(
			{
				basePath: ctx.value.store,
				actor: ctx.value.actor,
				defaultScope: await resolveScopeUri(args, ctx.value),
				scopeRequired: false,
			},
			{ name: "cabane" },
		);
		return success({ served: true }, "");
	},
};
