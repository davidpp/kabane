/**
 * Bearer auth.
 *
 * Checked in the `fetch` handler before any stub is obtained, so an
 * unauthenticated request cannot even wake the Durable Object.
 */

const SCHEME = "Bearer ";

const sha256 = (value: string): Promise<ArrayBuffer> =>
	crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

export namespace Auth {
	/**
	 * Constant-time compare of the presented token against the secret.
	 *
	 * Digesting both sides first is what makes this usable:
	 * `crypto.subtle.timingSafeEqual` throws when the two buffers differ in
	 * length, and guarding that with a length check would leak the secret's
	 * length. Two SHA-256 digests are always 32 bytes.
	 *
	 * No secret configured means no access — never open.
	 */
	export const authorize = async (
		request: Request,
		secret: string | undefined,
	): Promise<boolean> => {
		if (!secret) return false;

		const header = request.headers.get("Authorization");
		if (!header?.startsWith(SCHEME)) return false;

		const [presented, expected] = await Promise.all([
			sha256(header.slice(SCHEME.length)),
			sha256(secret),
		]);
		return crypto.subtle.timingSafeEqual(presented, expected);
	};
}
