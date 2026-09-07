/**
 * HTTP edge for the Cabane hub.
 *
 * `/health` is open. `/push` and `/pull` are the sync log routes, bearer
 * authenticated BEFORE any stub is obtained so an unauthenticated request
 * cannot wake a Durable Object. Everything else answers 401 for the same
 * reason: the route is only revealed to a caller who holds the token.
 *
 * The handler's whole job is auth, JSON and validation. Ordering and
 * idempotency belong to `CabaneLog`, the only thing that can guarantee them.
 * Cloudflare Access in front of every route and the MCP surface come with
 * JCAB-7.
 */

import type { Result } from "@cabane/core";
import { err, ok } from "@cabane/core";
import { Auth } from "./auth";
import { PullRequestSchema, PushRequestSchema } from "./wire";

/**
 * One log, one instance. Named for the log rather than for a person so a
 * second user would be `getByName(userId)` and nothing else changes.
 */
const SHARED_LOG = "cabane";

const fail = (status: number, message: string): Response =>
	Response.json({ error: message }, { status });

const respond = <T>(result: Result<T>): Response =>
	result.ok ? Response.json(result.value) : fail(500, result.error.message);

const readBody = async (request: Request): Promise<Result<unknown>> => {
	try {
		return ok(await request.json());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

export default {
	async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === "/health") {
			if (request.method !== "GET") return fail(405, "method not allowed");
			return Response.json({ ok: true, service: "cabane-worker" });
		}

		if (!(await Auth.authorize(request, env.SYNC_TOKEN))) {
			return fail(401, "unauthorized");
		}

		if (request.method !== "POST") return fail(405, "method not allowed");
		if (pathname !== "/push" && pathname !== "/pull") {
			return fail(404, "not found");
		}

		const body = await readBody(request);
		if (!body.ok)
			return fail(400, `malformed JSON body: ${body.error.message}`);

		const log = env.CABANE_LOG.getByName(SHARED_LOG);

		if (pathname === "/push") {
			const parsed = PushRequestSchema.safeParse(body.value);
			if (!parsed.success) return fail(400, parsed.error.message);
			return respond(await log.push(parsed.data));
		}

		const parsed = PullRequestSchema.safeParse(body.value);
		if (!parsed.success) return fail(400, parsed.error.message);
		return respond(await log.pull(parsed.data));
	},
};

export { CabaneHub } from "./hub";
export { CabaneLog } from "./log";
