/**
 * Calling a tool and composing the tool list, without the MCP SDK: `host.record` calls tools
 * through these in every process, so they stay on the barrel, and the SDK server that serves
 * them over a transport sits behind `@kabane/core/mcp-server` (`server.ts`).
 */

import { z } from "zod";
import { err, type Result } from "../result";
import { Runtime } from "../runtime";
import { KABANE_TOOLS, type ToolContext, type ToolDef } from "./tools";

/** Called after a write tool succeeds; the hub pushes to the log here. */
export type AfterWrite = (tool: ToolDef) => void;

const inputSchemas = new WeakMap<ToolDef, z.ZodObject<z.ZodRawShape>>();

export const callTool = async (
	tool: ToolDef,
	rawArgs: unknown,
	ctx: ToolContext,
	afterWrite?: AfterWrite,
): Promise<Result<unknown>> => {
	let schema = inputSchemas.get(tool);
	if (!schema) {
		schema = z.object(tool.input);
		inputSchemas.set(tool, schema);
	}
	const parsed = schema.safeParse(rawArgs ?? {});
	if (!parsed.success) {
		return err(
			new Error(
				`Invalid arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
			),
		);
	}
	const result = await tool.handler(parsed.data, ctx);
	if (result.ok && tool.kind === "write") afterWrite?.(tool);
	return result;
};

/** Shared tracker and registered module tools, resolved after host configuration. */
export const registeredTools = (): readonly ToolDef[] => [
	...KABANE_TOOLS,
	...Runtime.modules().flatMap((module) => module.tools ?? []),
];
