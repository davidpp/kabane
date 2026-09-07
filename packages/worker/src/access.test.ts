/**
 * The Access → principal → actor mapping, without a Cloudflare tenant. The
 * signature check is jose's job and is exercised by its own suite; what is
 * ours is who gets in and what name they write under.
 */

import { describe, expect, it } from "vitest";
import { Access, type AccessClaims } from "./access";
import {
	fakeAssertion,
	HERMES,
	HUMAN,
	STRANGER,
	UNKNOWN_SERVICE,
} from "./test-access";

const ENV = {
	ACCESS_TEAM_DOMAIN: "https://3pew.cloudflareaccess.com",
	ACCESS_AUD: "aud",
	HUMAN_EMAIL: "david@example.com",
	SERVICE_ACTORS: JSON.stringify({
		"hermes-client-id.access": "cabane://actor/agent/hermes",
	}),
	ACCESS_DEV_UNVERIFIED: "true",
};

const request = (token?: string): Request =>
	new Request("https://cabane.test/mcp", {
		headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
	});

describe("Access.principal", () => {
	const app = (claims: Partial<AccessClaims>): AccessClaims => ({
		type: "app",
		...claims,
	});

	it("maps a known service token to its agent actor", () => {
		const p = Access.principal(
			app({ common_name: "hermes-client-id.access" }),
			ENV,
		);
		expect(p).toEqual({
			ok: true,
			value: {
				kind: "service",
				subject: "hermes-client-id.access",
				actor: "cabane://actor/agent/hermes",
			},
		});
	});

	it("refuses a service token that is not in the map", () => {
		expect(Access.principal(app({ common_name: "nope" }), ENV).ok).toBe(false);
	});

	it("maps the configured human to a human actor from the email local part", () => {
		const p = Access.principal(app({ email: "David@Example.com" }), ENV);
		expect(p.ok && p.value.actor).toBe("cabane://actor/human/David");
	});

	it("refuses any other human, and everyone when no human is configured", () => {
		expect(Access.principal(app({ email: "x@y.z" }), ENV).ok).toBe(false);
		expect(
			Access.principal(app({ email: "david@example.com" }), {
				...ENV,
				HUMAN_EMAIL: "",
			}).ok,
		).toBe(false);
	});

	it("refuses tokens that are not app tokens or carry no identity", () => {
		expect(Access.principal({ email: "david@example.com" }, ENV).ok).toBe(
			false,
		);
		expect(Access.principal(app({}), ENV).ok).toBe(false);
	});

	it("reports a broken SERVICE_ACTORS rather than admitting anyone", () => {
		const p = Access.principal(app({ common_name: "x" }), {
			...ENV,
			SERVICE_ACTORS: "{ not json",
		});
		expect(p.ok).toBe(false);
		if (!p.ok) expect(p.error.message).toContain("SERVICE_ACTORS");
	});
});

describe("Access.authenticate (dev verifier)", () => {
	it("needs the assertion header", async () => {
		expect((await Access.authenticate(request(), ENV)).ok).toBe(false);
	});

	it("rejects a malformed assertion", async () => {
		expect((await Access.authenticate(request("nope"), ENV)).ok).toBe(false);
	});

	it("admits the fixtures the rest of the suite relies on", async () => {
		const human = await Access.authenticate(request(HUMAN), ENV);
		expect(human.ok && human.value.actor).toBe("cabane://actor/human/david");
		const hermes = await Access.authenticate(request(HERMES), ENV);
		expect(hermes.ok && hermes.value.actor).toBe("cabane://actor/agent/hermes");
		expect((await Access.authenticate(request(STRANGER), ENV)).ok).toBe(false);
		expect((await Access.authenticate(request(UNKNOWN_SERVICE), ENV)).ok).toBe(
			false,
		);
	});

	it("goes to the real verifier when dev mode is off, and a fake token fails there", async () => {
		const strict = { ...ENV, ACCESS_DEV_UNVERIFIED: undefined };
		const result = await Access.authenticate(
			request(fakeAssertion({ email: "david@example.com" })),
			strict,
		);
		expect(result.ok).toBe(false);
	});
});
