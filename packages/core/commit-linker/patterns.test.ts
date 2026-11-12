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
		expect(parseConventionalCommit("fix(MILL-123): resolve auth bug")).toEqual([
			"MILL-123",
		]);
		expect(parseConventionalCommit("feat(WORK-45): add login")).toEqual([
			"WORK-45",
		]);
	});

	it("parses multiple task IDs", () => {
		expect(
			parseConventionalCommit("feat(MILL-123, MILL-124): add login and signup"),
		).toEqual(["MILL-123", "MILL-124"]);
	});

	it("handles various commit types", () => {
		expect(parseConventionalCommit("docs(MILL-10): update readme")).toEqual([
			"MILL-10",
		]);
		expect(parseConventionalCommit("refactor(MILL-5): clean up code")).toEqual([
			"MILL-5",
		]);
		expect(parseConventionalCommit("test(ALL-1): add unit tests")).toEqual([
			"ALL-1",
		]);
	});

	it("returns empty for non-conventional commits", () => {
		expect(parseConventionalCommit("random commit message")).toEqual([]);
		expect(parseConventionalCommit("MILL-123: without type prefix")).toEqual(
			[],
		);
	});
});

describe("parseReferences", () => {
	it("parses Refs: pattern", () => {
		expect(parseReferences("Refs: MILL-123")).toEqual(["MILL-123"]);
		expect(parseReferences("refs MILL-45")).toEqual(["MILL-45"]);
		expect(parseReferences("Ref: MILL-1")).toEqual(["MILL-1"]);
	});

	it("parses refs with hash", () => {
		expect(parseReferences("refs #MILL-123")).toEqual(["MILL-123"]);
	});

	it("parses multiple refs", () => {
		expect(parseReferences("Refs: MILL-1, MILL-2")).toEqual([
			"MILL-1",
			"MILL-2",
		]);
	});

	it("finds refs in commit body", () => {
		const body = `Fix the login bug

Refs: MILL-123
Also related to MILL-456`;
		const refs = parseReferences(body);
		expect(refs).toContain("MILL-123");
	});
});

describe("parseCloseKeywords", () => {
	it("parses closes keyword", () => {
		expect(parseCloseKeywords("closes MILL-123")).toEqual(["MILL-123"]);
		expect(parseCloseKeywords("Closes MILL-45")).toEqual(["MILL-45"]);
	});

	it("parses fixes keyword", () => {
		expect(parseCloseKeywords("fixes MILL-123")).toEqual(["MILL-123"]);
		expect(parseCloseKeywords("Fixes MILL-45")).toEqual(["MILL-45"]);
	});

	it("parses resolves keyword", () => {
		expect(parseCloseKeywords("resolves MILL-123")).toEqual(["MILL-123"]);
	});

	it("handles singular and plural forms", () => {
		expect(parseCloseKeywords("close MILL-1")).toEqual(["MILL-1"]);
		expect(parseCloseKeywords("fix MILL-2")).toEqual(["MILL-2"]);
		expect(parseCloseKeywords("resolve MILL-3")).toEqual(["MILL-3"]);
	});
});

describe("parseAllTaskIds", () => {
	it("extracts all task IDs from message", () => {
		const message = "feat(MILL-123): implement feature for MILL-456";
		const ids = parseAllTaskIds(message);
		expect(ids).toContain("MILL-123");
		expect(ids).toContain("MILL-456");
	});

	it("returns unique IDs only", () => {
		const message = "MILL-123 MILL-123 MILL-123";
		const ids = parseAllTaskIds(message);
		expect(ids).toEqual(["MILL-123"]);
	});

	it("handles empty message", () => {
		expect(parseAllTaskIds("")).toEqual([]);
	});

	it("finds IDs with different prefixes", () => {
		const message = "Work on MILL-1, WORK-2, ALL-3";
		const ids = parseAllTaskIds(message);
		expect(ids).toContain("MILL-1");
		expect(ids).toContain("WORK-2");
		expect(ids).toContain("ALL-3");
	});
});

describe("hasCloseKeyword", () => {
	it("returns true when closes keyword present", () => {
		expect(hasCloseKeyword("closes MILL-123", "MILL-123")).toBe(true);
		expect(hasCloseKeyword("Fixes MILL-45", "MILL-45")).toBe(true);
	});

	it("returns false when closes keyword not present", () => {
		expect(hasCloseKeyword("refs MILL-123", "MILL-123")).toBe(false);
		expect(hasCloseKeyword("MILL-123 mentioned", "MILL-123")).toBe(false);
	});

	it("is case insensitive for task ID", () => {
		expect(hasCloseKeyword("closes mill-123", "MILL-123")).toBe(true);
		expect(hasCloseKeyword("closes MILL-123", "mill-123")).toBe(true);
	});

	it("returns false for different task ID", () => {
		expect(hasCloseKeyword("closes MILL-123", "MILL-456")).toBe(false);
	});
});
