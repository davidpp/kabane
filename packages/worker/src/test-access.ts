/**
 * Test fixtures: unsigned Access assertions the dev verifier accepts.
 *
 * Three base64url parts so `decodeJwt` treats it as a compact JWS; the
 * signature is a placeholder because `ACCESS_DEV_UNVERIFIED` skips it.
 */

import { ASSERTION_HEADER } from "./access";

const b64url = (value: string): string =>
	btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fakeAssertion = (payload: Record<string, unknown>): string =>
	`${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
		JSON.stringify({ type: "app", exp: 4102444800, ...payload }),
	)}.sig`;

export const HUMAN = fakeAssertion({ email: "david@example.com" });
export const HERMES = fakeAssertion({ common_name: "hermes-client-id.access" });
export const STRANGER = fakeAssertion({ email: "someone@else.example" });
export const UNKNOWN_SERVICE = fakeAssertion({ common_name: "nope.access" });

export const withAccess = (
	token: string,
	extra: Record<string, string> = {},
): Headers => {
	const headers = new Headers(extra);
	headers.set(ASSERTION_HEADER, token);
	return headers;
};
