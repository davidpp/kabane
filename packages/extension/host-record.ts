/** Record calls share the MCP boundary, including input validation and actor attribution. */
import {
	callTool,
	err,
	type Result,
	type ToolContext,
	type ToolDef,
} from "@cabane/core";
import type { Host } from "./host";

export const createHostRecord = (
	tools: readonly ToolDef[] | (() => readonly ToolDef[]),
	context:
		| ToolContext
		| (() => ToolContext | undefined | Promise<ToolContext | undefined>),
): Host.Record => {
	const call: Host.Record["call"] = async (name, input) => {
		const ctx = typeof context === "function" ? await context() : context;
		if (!ctx)
			return err(
				new Error(
					"the runtime is not configured yet for this host; call record after the factory returns and the store opens (standalone commands do not open it automatically)",
				),
			);
		const tool = (typeof tools === "function" ? tools() : tools).find(
			(tool) => tool.name === name,
		);
		if (!tool) return err(new Error(`Unknown tool: ${name}`));
		return callTool(tool, input, ctx);
	};
	// ToolDef erases handler results. These named wrappers pin the full-format contract;
	// real-database tests exercise every mapping and its returned record.
	// Strip presentation only here: call must preserve a module's paging inputs.
	const wrap =
		<T>(name: string) =>
		(input: unknown): Promise<Result<T>> =>
			call(
				name,
				typeof input === "object" && input !== null && !Array.isArray(input)
					? Object.fromEntries(
							Object.entries(input).filter(
								([key]) =>
									key !== "responseFormat" &&
									key !== "cursor" &&
									(name !== "kabane_comment" ||
										(key !== "text" && key !== "content")),
							),
						)
					: input,
			) as Promise<Result<T>>;
	return {
		get: wrap("kabane_get"),
		list: wrap("kabane_list"),
		edit: wrap("kabane_edit"),
		done: wrap("kabane_done"),
		comment: wrap("kabane_comment"),
		log: wrap("kabane_log"),
		context: wrap("kabane_context"),
		upstreamLink: wrap("kabane_upstream_link"),
		links: wrap("kabane_linkList"),
		upstreamLinks: wrap("kabane_upstreamList"),
		workLogs: wrap("kabane_logList"),
		call,
	};
};
