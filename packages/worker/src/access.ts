/**
 * Cloudflare Access at the Worker: verify the assertion, name the actor.
 *
 * Access rejects unauthenticated requests at the edge before this code runs
 * (docs/auth.md, topology a). Verifying the JWT here again is defence in depth
 * and, more to the point, the only way to learn WHO is calling: a service
 * token carries `common_name` (its client id), a human carries `email`. Both
 * map to an actor URI that `updated_by` records on every write.
 *
 * The standard Access JWT check: issuer is the team domain, audience is the
 * application AUD, JWKS from `/cdn-cgi/access/certs`.
 * Unknown service ids and any human other than the configured one are
 * refused — one human, N runtimes, nothing open by default.
 *
 * `ACCESS_DEV_UNVERIFIED=true` skips the signature check and trusts the
 * payload. It exists so `wrangler dev` and the vitest suite can exercise the
 * mapping with hand-made tokens; `wrangler.jsonc` never sets it.
 */

import { err, ok, type Result, tryCatch, trySync } from "@cabane/core";
import {
	createRemoteJWKSet,
	decodeJwt,
	type JWTPayload,
	jwtVerify,
} from "jose";
import { z } from "zod";

export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

export type AccessClaims = JWTPayload & {
	type?: string;
	common_name?: string;
	email?: string;
};

export type Principal = {
	kind: "service" | "human";
	/** `common_name` for a service, `email` for a human. */
	subject: string;
	/** The actor URI stamped on writes. */
	actor: string;
};

export type AccessEnv = Pick<
	Cloudflare.Env,
	| "ACCESS_TEAM_DOMAIN"
	| "ACCESS_AUD"
	| "HUMAN_EMAIL"
	| "SERVICE_ACTORS"
	| "ACCESS_DEV_UNVERIFIED"
>;

const ServiceActorsSchema = z.record(z.string().min(1));

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const jwksFor = (teamDomain: string) => {
	const cached = jwksByDomain.get(teamDomain);
	if (cached) return cached;
	const created = createRemoteJWKSet(
		new URL(`${teamDomain}/cdn-cgi/access/certs`),
	);
	jwksByDomain.set(teamDomain, created);
	return created;
};

const unauthorized = (reason: string): Error =>
	new Error(`unauthorized: ${reason}`);

export namespace Access {
	/** The claims, verified against the team's keys unless dev mode says otherwise. */
	export const verify = async (
		token: string,
		env: AccessEnv,
	): Promise<Result<AccessClaims>> => {
		if (env.ACCESS_DEV_UNVERIFIED === "true") {
			const decoded = trySync(() => decodeJwt(token) as AccessClaims);
			return decoded.ok
				? ok(decoded.value)
				: err(unauthorized("malformed assertion"));
		}
		const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
		const verified = await tryCatch(() =>
			jwtVerify(token, jwksFor(teamDomain), {
				algorithms: ["RS256"],
				issuer: teamDomain,
				audience: env.ACCESS_AUD,
				requiredClaims: ["exp"],
				clockTolerance: 30,
			}),
		);
		return verified.ok
			? ok(verified.value.payload as AccessClaims)
			: err(unauthorized("assertion rejected"));
	};

	/** Who the claims are, as an actor. Closed for anyone not configured. */
	export const principal = (
		claims: AccessClaims,
		env: Pick<AccessEnv, "HUMAN_EMAIL" | "SERVICE_ACTORS">,
	): Result<Principal> => {
		if (claims.type !== "app") return err(unauthorized("not an app token"));

		if (claims.common_name !== undefined) {
			const parsed = ServiceActorsSchema.safeParse(
				trySync(() => JSON.parse(env.SERVICE_ACTORS || "{}")).ok
					? JSON.parse(env.SERVICE_ACTORS || "{}")
					: undefined,
			);
			if (!parsed.success)
				return err(new Error("SERVICE_ACTORS is not valid JSON"));
			const actor = parsed.data[claims.common_name];
			if (!actor) return err(unauthorized("unknown service identity"));
			return ok({ kind: "service", subject: claims.common_name, actor });
		}

		const email = claims.email;
		if (!email) return err(unauthorized("no identity in assertion"));
		if (
			!env.HUMAN_EMAIL ||
			email.toLowerCase() !== env.HUMAN_EMAIL.toLowerCase()
		) {
			return err(unauthorized("unknown human identity"));
		}
		const local = email.split("@")[0] ?? email;
		return ok({
			kind: "human",
			subject: email,
			actor: `cabane://actor/human/${local}`,
		});
	};

	/** Header → claims → principal, or one `unauthorized` error. */
	export const authenticate = async (
		request: Request,
		env: AccessEnv,
	): Promise<Result<Principal>> => {
		const token = request.headers.get(ASSERTION_HEADER);
		if (!token) return err(unauthorized("missing assertion"));
		const claims = await verify(token, env);
		if (!claims.ok) return claims;
		return principal(claims.value, env);
	};
}
