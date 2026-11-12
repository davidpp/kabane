import { describe, expect, it } from "bun:test";
import {
	buildScopeFamilyMatch,
	derivePrefix,
	normalizeOptionalScopeUri,
	normalizeScopeUri,
	UNSCOPED_PREFIX,
} from "./helpers";

/** Canonical form, or the error message when the scope is unusable. */
const normalized = (scope: string): string => {
	const result = normalizeScopeUri(scope);
	return result.ok ? result.value : `ERR: ${result.error.message}`;
};

describe("normalizeScopeUri", () => {
	// Every spelling of the same scope has to land on one string, or a filter on
	// the canonical form silently misses the near-misses.
	const CANONICAL = "jake://scope/mill";
	it.each([
		["bare id", "mill"],
		["canonical URI", CANONICAL],
		["trailing slash", "jake://scope/mill/"],
		["repeated slashes", "jake://scope/mill//"],
		["leading whitespace", " mill"],
		["surrounding whitespace", "  mill  "],
		["whitespace around a URI", "  jake://scope/mill  "],
		["encoded whitespace in the URI", "jake://scope/%20mill"],
		["upper-case bare id", "MILL"],
		["title-case bare id", "Mill"],
		["padded upper-case bare id", "  MILL  "],
	])("collapses %s onto the canonical URI", (_label, input) => {
		expect(normalized(input)).toBe(CANONICAL);
	});

	it("is idempotent", () => {
		for (const input of [
			"mill",
			"MILL",
			CANONICAL,
			"jake://scope/mill/",
			" mill ",
			"github.com/user/repo",
			"/Users/alex/Projects/acme",
			"jake://scope/mill?client=acme",
		]) {
			const once = normalized(input);
			expect(normalized(once)).toBe(once);
		}
	});

	it("preserves extensions on a valid URI", () => {
		expect(normalized("jake://scope/mill?client=acme")).toBe(
			"jake://scope/mill?client=acme",
		);
		expect(normalized("jake://scope/mill/?client=acme")).toBe(
			"jake://scope/mill?client=acme",
		);
	});

	it("encodes a path-shaped scope ID and keeps its inner slashes", () => {
		expect(normalized("github.com/user/repo")).toBe(
			"jake://scope/github.com%2Fuser%2Frepo",
		);
		expect(normalized("jake://scope/github.com%2Fuser%2Frepo")).toBe(
			"jake://scope/github.com%2Fuser%2Frepo",
		);
	});

	// A stored scope ID may itself contain "://" — five live tasks sit under
	// "project://desk". Collapsing repeated slashes there rewrote it to
	// "project:/desk", silently moving those rows to a scope nothing queries.
	it("preserves a scheme embedded in a parsed scope ID", () => {
		const stored = `jake://scope/${encodeURIComponent("project://desk")}`;
		expect(normalized(stored)).toBe(stored);
	});

	// Case folding applies to typed bare ids only. Everything below is
	// cascade-derived, where the stored case is authoritative — folding it would
	// orphan live rows (hundreds of rows under a single path).
	it("keeps the case of a path-shaped bare ID, leading slash included", () => {
		for (const path of [
			"/Users/alex/Projects/acme",
			"/Users/alex/.mill/pa",
			"/Users/alex",
		]) {
			expect(normalized(path)).toBe(`jake://scope/${encodeURIComponent(path)}`);
		}
	});

	it("keeps a leading slash — it cannot be told apart from a path ID", () => {
		expect(normalized("/mill/")).toBe("jake://scope/%2Fmill");
		expect(normalized("jake://scope//mill//")).toBe("jake://scope/%2Fmill");
	});

	it("keeps the case of a host/owner/repo bare ID", () => {
		expect(normalized("GitHub.com/Foo/Bar")).toBe(
			"jake://scope/GitHub.com%2FFoo%2FBar",
		);
	});

	it("keeps the case of a full scope URI verbatim", () => {
		expect(normalized("jake://scope/GitHub.com/Foo")).toBe(
			"jake://scope/GitHub.com%2FFoo",
		);
		expect(normalized("jake://scope/MyRepo")).toBe("jake://scope/MyRepo");
	});

	it("rejects a malformed scope URI instead of burying it in a valid one", () => {
		expect(normalizeScopeUri("jake://scope/").ok).toBe(false);
		expect(normalizeScopeUri("jake://resource/task/01ABC").ok).toBe(false);
		expect(normalizeScopeUri("https://example.com/thing").ok).toBe(false);
	});

	it("rejects a scope with no usable ID", () => {
		expect(normalizeScopeUri("").ok).toBe(false);
		expect(normalizeScopeUri("   ").ok).toBe(false);
		expect(normalizeScopeUri("///").ok).toBe(false);
		expect(normalizeScopeUri("jake://scope/%20").ok).toBe(false);
	});
});

describe("normalizeOptionalScopeUri", () => {
	it("leaves an absent scope absent", () => {
		for (const absent of [undefined, null, ""]) {
			const result = normalizeOptionalScopeUri(absent);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBeUndefined();
		}
	});

	it("normalizes a present scope", () => {
		const result = normalizeOptionalScopeUri(" MILL ");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("jake://scope/mill");
	});
});

describe("buildScopeFamilyMatch", () => {
	it("matches the same family for every spelling of a scope", () => {
		for (const input of [
			"mill",
			"MILL",
			"jake://scope/mill",
			"jake://scope/mill/",
		]) {
			expect(buildScopeFamilyMatch(input)).toEqual({
				baseScopeUri: "jake://scope/mill",
				queryPattern: "jake://scope/mill?%",
			});
		}
	});

	it("matches the stored family for a path-shaped scope", () => {
		const stored = "jake://scope/%2FUsers%2Falex%2FProjects%2Facme";
		for (const input of ["/Users/alex/Projects/acme", stored]) {
			expect(buildScopeFamilyMatch(input)?.baseScopeUri).toBe(stored);
		}
	});

	it("returns undefined for an unusable filter (caller falls back to exact match)", () => {
		expect(buildScopeFamilyMatch("jake://scope/")).toBeUndefined();
	});
});

describe("derivePrefix", () => {
	it("returns the unscoped prefix when there is no scope", () => {
		const result = derivePrefix(undefined);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(UNSCOPED_PREFIX);
	});

	it("derives from the last segment of the scope ID", () => {
		const mill = derivePrefix("jake://scope/mill");
		expect(mill.ok).toBe(true);
		if (mill.ok) expect(mill.value).toBe("JMIL");

		const repo = derivePrefix("jake://scope/github.com%2Fuser%2Frepo");
		expect(repo.ok).toBe(true);
		if (repo.ok) expect(repo.value).toBe("JREP");
	});

	it("pads short scope IDs", () => {
		const result = derivePrefix("jake://scope/ab");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe("JABX");
	});

	it("errors on an un-normalized scope instead of falling back to JALL", () => {
		const result = derivePrefix("mill");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("mill");
	});

	it("errors when the scope ID has no alphanumeric characters", () => {
		expect(derivePrefix("jake://scope/---").ok).toBe(false);
	});
});
