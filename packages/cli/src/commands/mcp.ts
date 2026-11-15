import {
	err,
	ok,
	registeredTools,
	serveStdio,
	tryCatch,
	type Result,
	type ToolDef,
} from "@cabane/core";
import { type Extension, failure, success } from "@cabane/extension";
import { version } from "../../package.json";
import { ConfigSettings } from "../config-settings";
import { configTools } from "../config-tools";
import { type Command, openContext, resolveScopeUri } from "../context";
import { Extensions } from "../extensions";
import { MCP_INSTALL_USAGE, mcpInstall } from "./mcp-install";

/** Compose the enabled extensions, using the same selection as the board. */
export const extensionMcp = async (
	ctx: Extension.Ctx,
	hostTools: readonly ToolDef[],
	load: typeof Extensions.loadAll = Extensions.loadAll,
): Promise<Result<{ tools: ToolDef[]; instructions: string[] }>> => {
	const enabled = Extensions.enabled(ctx.home);
	if (!enabled.ok) return enabled;
	const loaded = await load(enabled.value);
	if (!loaded.ok) return loaded;
	const tools: ToolDef[] = [];
	const names = new Set(hostTools.map((tool) => tool.name));
	const instructions: string[] = [];
	for (const extension of loaded.value) {
		const contribute = extension.mcp;
		if (!contribute) continue;
		const contributed = await tryCatch(() => contribute(ctx));
		if (!contributed.ok)
			return err(
				new Error(
					`Extension ${extension.name} MCP failed: ${contributed.error.message}`,
				),
			);
		for (const tool of contributed.value.tools ?? []) {
			if (
				!tool.name.startsWith(`kabane_${extension.name}_`) ||
				tool.name === `kabane_${extension.name}_`
			)
				return err(
					new Error(
						`Extension ${extension.name} MCP tool ${tool.name} must be named kabane_${extension.name}_<verb>`,
					),
				);
			if (names.has(tool.name))
				return err(
					new Error(
						`Extension ${extension.name} MCP tool ${tool.name} duplicates an existing tool. Rename the extension tool.`,
					),
				);
			names.add(tool.name);
			tools.push({
				...tool,
				handler: async (input, toolCtx) => {
					const called = await tryCatch(() => tool.handler(input, toolCtx));
					const result = called.ok ? called.value : called;
					return result.ok
						? result
						: err(
								new Error(
									`Extension ${extension.name} MCP tool ${tool.name} failed: ${result.error.message}`,
								),
							);
				},
			});
		}
		if (contributed.value.instructions)
			instructions.push(contributed.value.instructions);
	}
	return ok({ tools, instructions });
};

/**
 * Serve this device's tracker and local config over MCP on stdio;
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
	usage: `kabane mcp [--as <actor-uri>]\n       ${MCP_INSTALL_USAGE}`,
	standalone: true,
	run: async (args, bare) => {
		if (args.positionals[0] === "install") return mcpInstall(args);
		const ctx = await openContext(bare.home, bare.cwd, args);
		if (!ctx.ok) return failure(ctx.error);
		const defaultScope = await resolveScopeUri(args, ctx.value);
		const where = await ConfigSettings.locate(
			bare.home,
			bare.cwd,
			defaultScope,
		);
		if (!where.ok) return failure(where.error);
		const hostTools = [
			...registeredTools(),
			...configTools(bare.home, where.value),
		];
		const contributions = await extensionMcp(ctx.value, hostTools);
		if (!contributions.ok) return failure(contributions.error);
		const served = await serveStdio(
			{
				basePath: ctx.value.store,
				actor: ctx.value.actor,
				// The configured actor, which `--as` never changes: who a relayed answer credits.
				humanActor: ctx.value.config.actor,
				defaultScope,
				scopeRequired: false,
			},
			{ name: "kabane", version },
			[...hostTools, ...contributions.value.tools],
			contributions.value.instructions,
		);
		if (!served.ok) return failure(served.error);
		return success({ served: true }, "");
	},
};
