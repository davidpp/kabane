/**
 * MCP server over the tool definitions.
 *
 * Two transports, one tool list. `serveStdio` blocks for a CLI process
 * (`kabane mcp`); `handleHttpRequest` is stateless Streamable HTTP for the hub:
 * a fresh server and transport per request, torn down after the response, so a
 * Durable Object never holds MCP session state and a request carries its own
 * actor.
 *
 * The low-level `Server` rather than `McpServer`: the high-level class infers
 * types over each tool's zod shape and, fed a generic `ZodRawShape`, tsc
 * recurses until it gives up (TS2589). Registering ListTools and CallTool by
 * hand is thirty lines and mirrors the Jake server this replaces.
 *
 * Handlers return `Result`; an `err` becomes an MCP tool error (`isError`),
 * never a thrown exception, so a bad id or a missing scope reads as a message
 * the agent can act on.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { err, type Result } from "../result";
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

const toSdkTool = (tool: ToolDef): Tool => ({
	name: tool.name,
	description: tool.description,
	inputSchema: zodToJsonSchema(z.object(tool.input), {
		$refStrategy: "none",
	}) as Tool["inputSchema"],
	annotations: { readOnlyHint: tool.kind === "read" },
});

const toCallResult = (result: Result<unknown>): CallToolResult => {
	if (!result.ok) {
		return {
			content: [{ type: "text", text: `Error: ${result.error.message}` }],
			isError: true,
		};
	}
	const text =
		typeof result.value === "string"
			? result.value
			: JSON.stringify(result.value, null, 2);
	return { content: [{ type: "text", text }] };
};

const callTool = async (
	tool: ToolDef,
	rawArgs: unknown,
	ctx: ToolContext,
	afterWrite?: AfterWrite,
): Promise<Result<unknown>> => {
	const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
	if (!parsed.success) {
		return err(new Error(`Invalid arguments: ${parsed.error.message}`));
	}
	const result = await tool.handler(parsed.data, ctx);
	if (result.ok && tool.kind === "write") afterWrite?.(tool);
	return result;
};

/** A server with every tool registered against `ctx`. */
export const createMcpServer = (
	ctx: ToolContext,
	info: McpServerInfo = {},
	afterWrite?: AfterWrite,
): Server => {
	const server = new Server(
		{ ...DEFAULT_INFO, ...info },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
	);
	const tools = KABANE_TOOLS.map(toSdkTool);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = KABANE_TOOLS.find((t) => t.name === request.params.name);
		if (!tool) {
			return toCallResult(
				err(new Error(`Unknown tool: ${request.params.name}`)),
			);
		}
		return toCallResult(
			await callTool(tool, request.params.arguments, ctx, afterWrite),
		);
	});

	return server;
};

/**
 * Serve on stdio until the transport closes. Nothing may be written to
 * stdout by the caller before or during this: stdout is the wire.
 */
export const serveStdio = async (
	ctx: ToolContext,
	info: McpServerInfo = {},
): Promise<void> => {
	const server = createMcpServer(ctx, info);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	await new Promise<void>((resolve) => {
		transport.onclose = () => resolve();
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				void server.close();
				resolve();
			});
		}
	});
};

/**
 * Answer one Streamable HTTP request. Stateless: no session id is issued, a
 * GET (the SSE stream) is refused by the transport, JSON responses are
 * returned directly.
 */
export const handleHttpRequest = async (
	ctx: ToolContext,
	request: Request,
	info: McpServerInfo = {},
	afterWrite?: AfterWrite,
): Promise<Response> => {
	const server = createMcpServer(ctx, info, afterWrite);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await server.close();
	}
};
