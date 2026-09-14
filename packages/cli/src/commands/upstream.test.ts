import { describe, expect, it } from "bun:test";
import { identifierOf, providerOf } from "./upstream";

describe("providerOf", () => {
	it("reads the tracker off the host", () => {
		expect(providerOf("https://linear.app/acme/issue/ENG-123/some-title")).toBe(
			"linear",
		);
		expect(providerOf("https://github.com/acme/web/issues/42")).toBe("github");
	});

	it("is null for a host it does not know, which is what --provider is for", () => {
		expect(providerOf("https://jira.acme.com/browse/ENG-1")).toBeNull();
	});

	it("is null rather than throwing on something that is not a url", () => {
		expect(providerOf("ENG-123")).toBeNull();
	});
});

describe("identifierOf", () => {
	it("pulls the issue key out of a linear url", () => {
		expect(
			identifierOf("linear", "https://linear.app/acme/issue/ENG-123/a-title"),
		).toBe("ENG-123");
	});

	it("builds owner/repo#n for github", () => {
		expect(
			identifierOf("github", "https://github.com/acme/web/issues/42"),
		).toBe("acme/web#42");
	});

	it("is null when the path is not issue-shaped", () => {
		expect(
			identifierOf("linear", "https://linear.app/acme/team/ENG"),
		).toBeNull();
		expect(
			identifierOf("github", "https://github.com/acme/web/pull/42"),
		).toBeNull();
	});

	it("is null for a provider it has no rule for", () => {
		expect(
			identifierOf("jira", "https://jira.acme.com/browse/ENG-1"),
		).toBeNull();
	});
});
