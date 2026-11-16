import {
	createMcpServer,
	type ToolContext,
	type McpServerInfo,
	type AfterWrite,
} from "@cabane/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

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
	const created = createMcpServer(ctx, info, afterWrite);
	if (!created.ok)
		return Response.json({ error: created.error.message }, { status: 500 });
	const server = created.value;
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
