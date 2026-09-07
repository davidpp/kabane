/**
 * HTTP edge for the Cabane hub. This slice answers `/health` and nothing else;
 * the Access check, the sync routes and the MCP route come with later issues.
 */

const fail = (status: number, message: string): Response =>
	Response.json({ error: message }, { status });

export default {
	async fetch(request: Request, _env: Cloudflare.Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== "/health") return fail(404, "not found");
		if (request.method !== "GET") return fail(405, "method not allowed");
		return Response.json({ ok: true, service: "cabane-worker" });
	},
};

export { CabaneHub } from "./hub";
export { CabaneLog } from "./log";
