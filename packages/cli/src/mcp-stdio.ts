import {
	createMcpServer,
	registeredTools,
	ok,
	type Result,
	type ToolContext,
	type ToolDef,
	type McpServerInfo,
} from "@cabane/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Serve on stdio until the transport closes. Nothing may be written to
 * stdout by the caller before or during this: stdout is the wire.
 */
export const serveStdio = async (
	ctx: ToolContext,
	info: McpServerInfo = {},
	tools: readonly ToolDef[] = registeredTools(),
	instructions: readonly string[] = [],
): Promise<Result<void>> => {
	const created = createMcpServer(ctx, info, undefined, tools, instructions);
	if (!created.ok) return created;
	const server = created.value;
	const transport = new StdioServerTransport();
	await server.connect(transport);
	await new Promise<void>((resolve) => {
		transport.onclose = () => resolve();
		// The SDK transport never watches for end of input, so without this a server whose client
		// went away keeps its process alive, spinning on a closed stdin.
		process.stdin.once("end", () => void server.close());
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.once(signal, () => {
				void server.close();
				resolve();
			});
		}
	});
	return ok(undefined);
};
