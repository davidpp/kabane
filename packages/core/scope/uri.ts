import { err, ok, type Result } from "../result";
import {
	type ParsedScopeUri,
	ParsedScopeUriSchema,
	type ScopeQuery,
	type ScopeUriParts,
} from "./schemas";

/**
 * Scope URI utilities.
 *
 * Format: jake://scope/<scopeId>?<extensions>
 * Example: jake://scope/jake?client=acme&session=xyz
 */
export namespace ScopeUri {
	const SCHEME = "jake";
	const NAMESPACE = "scope";
	const PREFIX = `${SCHEME}://${NAMESPACE}/`;

	/**
	 * Parse a scope URI string into components
	 *
	 * @example
	 * parse("jake://scope/jake?client=acme")
	 * // → { ok: true, value: { scheme: 'jake', namespace: 'scope', scopeId: 'jake', extensions: { client: 'acme' } } }
	 */
	export const parse = (uri: string): Result<ParsedScopeUri> => {
		if (!uri.startsWith(PREFIX)) {
			return err(new Error(`Invalid scope URI: must start with "${PREFIX}"`));
		}

		const rest = uri.slice(PREFIX.length);
		const [pathPart, queryPart] = rest.split("?", 2);

		if (!pathPart) {
			return err(new Error("Invalid scope URI: missing scopeId"));
		}

		// Decode the scopeId (may contain encoded characters)
		const scopeId = decodeURIComponent(pathPart);

		// Parse query params into extensions
		let extensions: Record<string, string> | undefined;
		if (queryPart) {
			extensions = {};
			const params = new URLSearchParams(queryPart);
			for (const [key, value] of params) {
				extensions[key.toLowerCase()] = value;
			}
		}

		const parsed: ParsedScopeUri = {
			scheme: SCHEME,
			namespace: NAMESPACE,
			scopeId,
			extensions:
				extensions && Object.keys(extensions).length > 0
					? extensions
					: undefined,
		};

		// Validate with Zod
		const result = ParsedScopeUriSchema.safeParse(parsed);
		if (!result.success) {
			return err(new Error(`Invalid scope URI: ${result.error.message}`));
		}

		return ok(result.data);
	};

	/**
	 * Format components into a scope URI string
	 *
	 * @example
	 * format({ scopeId: 'jake', extensions: { client: 'acme' } })
	 * // → "jake://scope/jake?client=acme"
	 */
	export const format = (parts: ScopeUriParts): string => {
		// Encode the scopeId for URL safety
		const encodedScopeId = encodeURIComponent(parts.scopeId);
		let uri = `${PREFIX}${encodedScopeId}`;

		if (parts.extensions && Object.keys(parts.extensions).length > 0) {
			// Sort keys for canonical output
			const sortedEntries = Object.entries(parts.extensions).sort(([a], [b]) =>
				a < b ? -1 : 1,
			);
			const params = new URLSearchParams();
			for (const [key, value] of sortedEntries) {
				params.set(key.toLowerCase(), value);
			}
			uri += `?${params.toString()}`;
		}

		return uri;
	};

	/**
	 * Canonicalize a scope URI (sort params, lowercase keys, normalize)
	 *
	 * @example
	 * canonicalize("jake://scope/jake?Session=xyz&Client=acme")
	 * // → "jake://scope/jake?client=acme&session=xyz"
	 */
	export const canonicalize = (uri: string): Result<string> => {
		const parsed = parse(uri);
		if (!parsed.ok) {
			return parsed;
		}
		return ok(format(parsed.value));
	};

	/**
	 * Check if a URI matches a query (with optional extension filters)
	 *
	 * - Query with scopeId only: matches all URIs with that scopeId
	 * - Query with extensions: matches only if all specified extensions match
	 *
	 * @example
	 * matches("jake://scope/jake?client=acme", { scopeId: 'jake' })
	 * // → true
	 *
	 * matches("jake://scope/jake?client=acme", { scopeId: 'jake', extensions: { client: 'globex' } })
	 * // → false
	 */
	export const matches = (uri: string, query: ScopeQuery): boolean => {
		const parsed = parse(uri);
		if (!parsed.ok) {
			return false;
		}

		// Check scopeId if specified
		if (query.scopeId && parsed.value.scopeId !== query.scopeId) {
			return false;
		}

		// Check extensions if specified (exact match on specified keys)
		if (query.extensions) {
			const uriExtensions = parsed.value.extensions ?? {};
			for (const [key, value] of Object.entries(query.extensions)) {
				if (uriExtensions[key.toLowerCase()] !== value) {
					return false;
				}
			}
		}

		return true;
	};

	/**
	 * Extract just the scopeId from a URI
	 */
	export const getScopeId = (uri: string): Result<string> => {
		const parsed = parse(uri);
		if (!parsed.ok) {
			return parsed;
		}
		return ok(parsed.value.scopeId);
	};

	/**
	 * Check if a string is a valid scope URI
	 */
	export const isValid = (uri: string): boolean => {
		return parse(uri).ok;
	};

	/**
	 * Create a simple scope URI from just a scopeId
	 */
	export const fromScopeId = (scopeId: string): string => {
		return format({ scopeId });
	};

	/**
	 * Add or update extensions on an existing URI
	 */
	export const withExtensions = (
		uri: string,
		extensions: Record<string, string>,
	): Result<string> => {
		const parsed = parse(uri);
		if (!parsed.ok) {
			return parsed;
		}

		return ok(
			format({
				scopeId: parsed.value.scopeId,
				extensions: {
					...parsed.value.extensions,
					...extensions,
				},
			}),
		);
	};
}
