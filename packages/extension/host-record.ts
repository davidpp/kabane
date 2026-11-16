/** Record calls share the MCP boundary, including input validation and actor attribution. */
import {
	callTool,
	NotFoundError,
	ok,
	type Task,
	err,
	type Result,
	type ToolContext,
	type ToolDef,
} from "@cabane/core";
import type { Host } from "./host";
import { HostWrites } from "./host-store";

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
		if (tool.kind === "write") {
			if (HostWrites.open())
				return err(
					new Error(
						`${name} writes, and a store.write is open in this call chain, holding the database's write lock until it returns; change the task with tx.updateTask, write with tx.db, or call ${name} after store.write returns`,
					),
				);
			const turn = await HostWrites.take(`host.record ${name}`);
			if (!turn.ok) return turn;
			try {
				return await callTool(tool, input, ctx);
			} finally {
				HostWrites.release(turn.value);
			}
		}
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
		get: async (input) => {
			const task = await wrap<Task>("kabane_get")(input);
			return !task.ok && task.error instanceof NotFoundError ? ok(null) : task;
		},
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
