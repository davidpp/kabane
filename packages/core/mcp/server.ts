/**
 * MCP server over the tool definitions.
 *
 * Hosts connect their own transports to this shared tool server.
 *
 * The low-level `Server` rather than `McpServer`: the high-level class infers
 * types over each tool's zod shape and, fed a generic `ZodRawShape`, tsc
 * recurses until it gives up (TS2589). Registering ListTools and CallTool by
 * hand is thirty lines.
 *
 * Handlers return `Result`; an `err` becomes an MCP tool error (`isError`),
 * never a thrown exception, so a bad id or a missing scope reads as a message
 * the agent can act on.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CONTEXT_SECTIONS, registeredContextSections } from "../context-output";
import { err, ok, type Result } from "../result";
import { Runtime } from "../runtime";
import {
	KABANE_TOOLS,
	SERVER_INSTRUCTIONS,
	type ToolContext,
	type ToolDef,
} from "./tools";

export type McpServerInfo = {
	name?: string;
	version?: string;
};

const DEFAULT_INFO = { name: "kabane", version: "0.1.0" };

/** Called after a write tool succeeds; the hub pushes to the log here. */
export type AfterWrite = (tool: ToolDef) => void;

const toSdkTool = (
	tool: ToolDef,
	sections: z.ZodEnum<Record<string, string>>,
): Tool => ({
	name: tool.name,
	description: tool.description,
	inputSchema: z.toJSONSchema(
		z.object(
			tool.name === "kabane_context"
				? {
						...tool.input,
						sections: z
							.array(sections)
							.max(100)
							.default(sections.options)
							.optional(),
					}
				: tool.input,
		),
		{
			target: "draft-7",
			io: "input",
			unrepresentable: "throw",
			override: ({ zodSchema, jsonSchema }) => {
				// Stripping objects accept extra input, but MCP only advertises their declared keys.
				if (zodSchema instanceof z.ZodObject && !zodSchema.def.catchall)
					jsonSchema.additionalProperties = false;
			},
		},
	) as Tool["inputSchema"],
	annotations: {
		readOnlyHint: tool.kind === "read",
		...(tool.annotations?.destructiveHint !== undefined
			? { destructiveHint: tool.annotations.destructiveHint }
			: {}),
		...(tool.annotations?.openWorldHint !== undefined
			? { openWorldHint: tool.annotations.openWorldHint }
			: {}),
	},
});

const toCallResult = (
	result: Result<unknown>,
	concise = false,
): CallToolResult => {
	if (!result.ok) {
		const message = concise
			? result.error.message.slice(0, 400)
			: result.error.message;
		const suffix =
			message === result.error.message
				? ""
				: "… [error truncated; check arguments]";
		return {
			content: [{ type: "text", text: `Error: ${message}${suffix}` }],
			isError: true,
		};
	}
	const text =
		typeof result.value === "string"
			? result.value
			: JSON.stringify(result.value, null, concise ? undefined : 2);
	return { content: [{ type: "text", text }] };
};

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

/** A server with every tool registered against `ctx`; duplicate names are refused. */
export const createMcpServer = (
	ctx: ToolContext,
	info: McpServerInfo = {},
	afterWrite?: AfterWrite,
	toolDefs: readonly ToolDef[] = registeredTools(),
	instructions: readonly string[] = [],
): Result<Server> => {
	const names = new Set<string>();
	for (const tool of toolDefs) {
		if (names.has(tool.name))
			return err(
				new Error(
					`Duplicate MCP tool name: ${tool.name}. Rename the module or host tool.`,
				),
			);
		names.add(tool.name);
	}
	const server = new Server(
		{ ...DEFAULT_INFO, ...info },
		{
			capabilities: { tools: {} },
			instructions: [
				SERVER_INSTRUCTIONS,
				...Runtime.modules().flatMap((module) =>
					module.instructions ? [module.instructions] : [],
				),
				...instructions,
			].join("\n\n"),
		},
	);
	const sections = z.enum([
		CONTEXT_SECTIONS[0],
		...registeredContextSections().slice(1),
	]);
	const tools = toolDefs.map((tool) => toSdkTool(tool, sections));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = toolDefs.find((t) => t.name === request.params.name);
		if (!tool) {
			return toCallResult(
				err(new Error(`Unknown tool: ${request.params.name}`)),
			);
		}
		return toCallResult(
			await callTool(tool, request.params.arguments, ctx, afterWrite),
			tool.input.responseFormat !== undefined &&
				request.params.arguments?.responseFormat === "concise",
		);
	});

	return ok(server);
};
