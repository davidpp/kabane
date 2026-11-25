import {
	err,
	ok,
	registeredTools,
	tryCatch,
	type Result,
	type ToolDef,
} from "@kabane/core";
import { type Extension, failure, success } from "@kabane/extension";
import { z } from "zod";
import { version } from "../../package.json";
import { ConfigSettings } from "../config-settings";
import { configTools } from "../config-tools";
import { type Command, openContext, resolveScopeUri } from "../context";
import { Extensions } from "../extensions";
import { Self } from "../self";
import { Skills } from "../skills";
import { MCP_INSTALL_USAGE, mcpInstall } from "./mcp-install";

const McpContribution = z.object({
	instructions: z.string().optional(),
	tools: z
		.array(
			z.object({
				name: z.string(),
				description: z.string(),
				input: z.record(z.string(), Extensions.zodSchema),
				kind: z.enum(["read", "write"]),
				annotations: z
					.object({
						destructiveHint: z.boolean().optional(),
						openWorldHint: z.boolean().optional(),
					})
					.optional(),
				handler: z.custom<ToolDef["handler"]>(
					(value) => typeof value === "function",
					"must be a function",
				),
			}),
		)
		.optional(),
});

/** Compose the enabled extensions, using the same selection as the board. */
export const extensionMcp = async (
	ctx: Extension.Ctx,
	hostTools: readonly ToolDef[],
): Promise<
	Result<{
		tools: ToolDef[];
		instructions: string[];
		directories: Extensions.Directory[];
	}>
> => {
	const enabled = Extensions.enabled(ctx.home);
	if (!enabled.ok) return enabled;
	const loaded = await Extensions.loadAll(enabled.value, ctx.home);
	Extensions.report(loaded.refused);
	const tools: ToolDef[] = [];
	const names = new Set(hostTools.map((tool) => tool.name));
	const instructions: string[] = [];
	for (const extension of loaded.loaded) {
		const contribute = extension.mcp;
		if (!contribute) continue;
		const contributed = await tryCatch(() => contribute(ctx));
		if (!contributed.ok) {
			Extensions.report([
				{
					name: extension.name,
					reason: `MCP contribution failed: ${Extensions.cause(contributed.error)}; repair its mcp function; ${Extensions.disabledAdvice}`,
				},
			]);
			continue;
		}
		const parsed = McpContribution.safeParse(contributed.value);
		if (!parsed.success) {
			Extensions.report([
				{
					name: extension.name,
					reason: `MCP contribution is invalid: ${Extensions.invalid(parsed.error)}; ${Extensions.disabledAdvice}`,
				},
			]);
			continue;
		}
		// The validated originals: the parsed copies lose any field the schema does not list.
		const pending = contributed.value.tools ?? [];
		const seen = new Set(names);
		let reason: string | undefined;
		for (const tool of pending) {
			if (
				!tool.name.startsWith(`kabane_${extension.name}_`) ||
				tool.name === `kabane_${extension.name}_`
			) {
				reason = `MCP tool ${tool.name} must be named kabane_${extension.name}_<verb>; rename it; ${Extensions.disabledAdvice}`;
				break;
			}
			if (seen.has(tool.name)) {
				reason = `MCP tool ${tool.name} duplicates an existing tool; rename the extension tool; ${Extensions.disabledAdvice}`;
				break;
			}
			seen.add(tool.name);
		}
		if (reason) {
			Extensions.report([{ name: extension.name, reason }]);
			continue;
		}
		for (const tool of pending) {
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
		if (parsed.data.instructions) instructions.push(parsed.data.instructions);
	}
	return ok({ tools, instructions, directories: loaded.directories });
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
		const { directories } = contributions.value;
		Extensions.report(Skills.read(directories).refused);
		const skills = Skills.tools(
			directories,
			Skills.command(bare.home, Self.current() ?? "kabane"),
		);
		// Imported here, not at the top: main.ts imports every command, and the MCP SDK and its ajv
		// should load only in the process that serves.
		const { serveStdio } = await import("../mcp-stdio");
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
			[...hostTools, ...skills, ...contributions.value.tools],
			[Skills.INSTRUCTIONS, ...contributions.value.instructions],
		);
		if (!served.ok) return failure(served.error);
		return success({ served: true }, "");
	},
};
