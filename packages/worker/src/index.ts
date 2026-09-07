/**
 * HTTP edge for the Cabane hub.
 *
 * EVERY ROUTE IS BEHIND ACCESS, health included (docs/auth.md). The assertion
 * is verified and mapped to a principal BEFORE any stub is obtained, so an
 * unauthenticated request cannot wake a Durable Object. Cloudflare Access
 * itself rejects at the edge first; this is the second wall and the source of
 * the actor identity.
 *
 * Routes:
 * - `GET  /health`  who you are, and that the Worker is up
 * - `POST /push`, `POST /pull`  the sync log, additionally bearer-authenticated
 *   with `SYNC_TOKEN` (the log's own check, kept so a device presents both the
 *   Access service token and the log secret)
 * - `POST /mcp`  Streamable HTTP MCP on the hub, actor forwarded in a header
 *
 * The handler's whole job is auth, JSON, validation and routing. Ordering and
 * idempotency belong to `CabaneLog`; tools and sync belong to `CabaneHub`.
 */

import type { Result } from "@cabane/core";
import { err, ok } from "@cabane/core";
import { Access, type Principal } from "./access";
import { Auth } from "./auth";
import { ACTOR_HEADER, HUB_NAME, SHARED_LOG } from "./names";
import { PullRequestSchema, PushRequestSchema } from "./wire";

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

const serveLog = async (
	request: Request,
	env: Cloudflare.Env,
	pathname: "/push" | "/pull",
): Promise<Response> => {
	if (!(await Auth.authorize(request, env.SYNC_TOKEN))) {
		return fail(401, "unauthorized");
	}
	if (request.method !== "POST") return fail(405, "method not allowed");

	const body = await readBody(request);
	if (!body.ok) return fail(400, `malformed JSON body: ${body.error.message}`);

	const log = env.CABANE_LOG.getByName(SHARED_LOG);

	if (pathname === "/push") {
		const parsed = PushRequestSchema.safeParse(body.value);
		if (!parsed.success) return fail(400, parsed.error.message);
		return respond(await log.push(parsed.data));
	}

	const parsed = PullRequestSchema.safeParse(body.value);
	if (!parsed.success) return fail(400, parsed.error.message);
	return respond(await log.pull(parsed.data));
};

/**
 * Forward to the hub with the verified actor. The header is SET, not appended:
 * whatever a client put there is discarded.
 */
const serveMcp = async (
	request: Request,
	env: Cloudflare.Env,
	principal: Principal,
): Promise<Response> => {
	if (request.method !== "POST") return fail(405, "method not allowed");
	const headers = new Headers(request.headers);
	headers.set(ACTOR_HEADER, principal.actor);
	const forwarded = new Request(request, { headers });
	return env.CABANE_HUB.getByName(HUB_NAME).fetch(forwarded);
};

export default {
	async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		// BEFORE any stub. Access rejected at the edge already; this is where the
		// Worker learns who it is talking to, and refuses anyone it cannot name.
		const principal = await Access.authenticate(request, env);
		if (!principal.ok) return fail(401, "unauthorized");

		const { pathname } = new URL(request.url);

		if (pathname === "/health") {
			if (request.method !== "GET") return fail(405, "method not allowed");
			return Response.json({
				ok: true,
				service: "cabane-worker",
				actor: principal.value.actor,
			});
		}

		if (pathname === "/push" || pathname === "/pull") {
			return serveLog(request, env, pathname);
		}

		if (pathname === "/mcp") return serveMcp(request, env, principal.value);

		return fail(404, "not found");
	},
};

export { CabaneHub } from "./hub";
export { CabaneLog } from "./log";
