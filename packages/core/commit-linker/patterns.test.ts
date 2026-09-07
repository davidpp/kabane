/**
 * Commit Linker Patterns Tests
 */
import { describe, expect, it } from "bun:test";
import {
	hasCloseKeyword,
	parseAllTaskIds,
	parseCloseKeywords,
	parseConventionalCommit,
	parseReferences,
} from "./patterns";

describe("parseConventionalCommit", () => {
	it("parses single task ID in conventional commit", () => {
		expect(parseConventionalCommit("fix(JAKE-123): resolve auth bug")).toEqual([
			"JAKE-123",
		]);
		expect(parseConventionalCommit("feat(WORK-45): add login")).toEqual([
			"WORK-45",
		]);
	});

	it("parses multiple task IDs", () => {
		expect(
			parseConventionalCommit("feat(JAKE-123, JAKE-124): add login and signup"),
		).toEqual(["JAKE-123", "JAKE-124"]);
	});

	it("handles various commit types", () => {
		expect(parseConventionalCommit("docs(JAKE-10): update readme")).toEqual([
			"JAKE-10",
		]);
		expect(parseConventionalCommit("refactor(JAKE-5): clean up code")).toEqual([
			"JAKE-5",
		]);
		expect(parseConventionalCommit("test(ALL-1): add unit tests")).toEqual([
			"ALL-1",
		]);
	});

	it("returns empty for non-conventional commits", () => {
		expect(parseConventionalCommit("random commit message")).toEqual([]);
		expect(parseConventionalCommit("JAKE-123: without type prefix")).toEqual(
			[],
		);
	});
});

describe("parseReferences", () => {
	it("parses Refs: pattern", () => {
		expect(parseReferences("Refs: JAKE-123")).toEqual(["JAKE-123"]);
		expect(parseReferences("refs JAKE-45")).toEqual(["JAKE-45"]);
		expect(parseReferences("Ref: JAKE-1")).toEqual(["JAKE-1"]);
	});

	it("parses refs with hash", () => {
		expect(parseReferences("refs #JAKE-123")).toEqual(["JAKE-123"]);
	});

	it("parses multiple refs", () => {
		expect(parseReferences("Refs: JAKE-1, JAKE-2")).toEqual([
			"JAKE-1",
			"JAKE-2",
		]);
	});

	it("finds refs in commit body", () => {
		const body = `Fix the login bug

Refs: JAKE-123
Also related to JAKE-456`;
		const refs = parseReferences(body);
		expect(refs).toContain("JAKE-123");
	});
});

describe("parseCloseKeywords", () => {
	it("parses closes keyword", () => {
		expect(parseCloseKeywords("closes JAKE-123")).toEqual(["JAKE-123"]);
		expect(parseCloseKeywords("Closes JAKE-45")).toEqual(["JAKE-45"]);
	});

	it("parses fixes keyword", () => {
		expect(parseCloseKeywords("fixes JAKE-123")).toEqual(["JAKE-123"]);
		expect(parseCloseKeywords("Fixes JAKE-45")).toEqual(["JAKE-45"]);
	});

	it("parses resolves keyword", () => {
		expect(parseCloseKeywords("resolves JAKE-123")).toEqual(["JAKE-123"]);
	});

	it("handles singular and plural forms", () => {
		expect(parseCloseKeywords("close JAKE-1")).toEqual(["JAKE-1"]);
		expect(parseCloseKeywords("fix JAKE-2")).toEqual(["JAKE-2"]);
		expect(parseCloseKeywords("resolve JAKE-3")).toEqual(["JAKE-3"]);
	});
});

describe("parseAllTaskIds", () => {
	it("extracts all task IDs from message", () => {
		const message = "feat(JAKE-123): implement feature for JAKE-456";
		const ids = parseAllTaskIds(message);
		expect(ids).toContain("JAKE-123");
		expect(ids).toContain("JAKE-456");
	});

	it("returns unique IDs only", () => {
		const message = "JAKE-123 JAKE-123 JAKE-123";
		const ids = parseAllTaskIds(message);
		expect(ids).toEqual(["JAKE-123"]);
	});

	it("handles empty message", () => {
		expect(parseAllTaskIds("")).toEqual([]);
	});

	it("finds IDs with different prefixes", () => {
		const message = "Work on JAKE-1, WORK-2, ALL-3";
		const ids = parseAllTaskIds(message);
		expect(ids).toContain("JAKE-1");
		expect(ids).toContain("WORK-2");
		expect(ids).toContain("ALL-3");
	});
});

describe("hasCloseKeyword", () => {
	it("returns true when closes keyword present", () => {
		expect(hasCloseKeyword("closes JAKE-123", "JAKE-123")).toBe(true);
		expect(hasCloseKeyword("Fixes JAKE-45", "JAKE-45")).toBe(true);
	});

	it("returns false when closes keyword not present", () => {
		expect(hasCloseKeyword("refs JAKE-123", "JAKE-123")).toBe(false);
		expect(hasCloseKeyword("JAKE-123 mentioned", "JAKE-123")).toBe(false);
	});

	it("is case insensitive for task ID", () => {
		expect(hasCloseKeyword("closes jake-123", "JAKE-123")).toBe(true);
		expect(hasCloseKeyword("closes JAKE-123", "jake-123")).toBe(true);
	});

	it("returns false for different task ID", () => {
		expect(hasCloseKeyword("closes JAKE-123", "JAKE-456")).toBe(false);
	});
});
