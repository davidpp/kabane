import { describe, expect, it } from "bun:test";
import { type ReopenEvent, RiskAnalyzer, type SubtaskInput } from "./risks";

// ── Helpers ──────────────────────────────────────────────────────────

const makeSubtask = (
	id: string,
	title: string,
	description?: string,
): SubtaskInput => ({
	id,
	shortId: id,
	title,
	description: description ?? null,
});

const makeReopen = (subtaskId: string): ReopenEvent => ({
	subtaskId,
	status: "reopened",
});

const makeCompleted = (subtaskId: string): ReopenEvent => ({
	subtaskId,
	status: "completed",
});

/** A description long enough not to trigger `vague_description`. */
const longDescription = (preface: string): string =>
	`${preface}. ${"Additional detail to satisfy minimum description length requirement.".padEnd(60, " ")}`;

// ── checkFileOverlap ─────────────────────────────────────────────────

describe("RiskAnalyzer.checkFileOverlap", () => {
	it("returns empty when no overlap", () => {
		const subtasks = [
			makeSubtask("A", "Work on foo", "Modify `packages/loop/foo.ts`"),
			makeSubtask("B", "Work on bar", "Modify `packages/loop/bar.ts`"),
		];
		const risks = RiskAnalyzer.checkFileOverlap(subtasks);
		expect(risks).toEqual([]);
	});

	it("detects overlap in descriptions", () => {
		const subtasks = [
			makeSubtask("A", "Schema work", "Modify `packages/loop/schemas/loop.ts`"),
			makeSubtask(
				"B",
				"More schema work",
				"Also modify `packages/loop/schemas/loop.ts`",
			),
		];
		const risks = RiskAnalyzer.checkFileOverlap(subtasks);
		expect(risks.length).toBe(1);
		expect(risks[0]?.type).toBe("file_overlap");
		expect(risks[0]?.message).toContain("packages/loop/schemas/loop.ts");
	});

	it("returns high severity for 3+ subtasks on same file", () => {
		const subtasks = [
			makeSubtask("A", "x", "Modify `packages/loop/cli/handler.ts`"),
			makeSubtask("B", "y", "Also modify `packages/loop/cli/handler.ts`"),
			makeSubtask("C", "z", "And more `packages/loop/cli/handler.ts`"),
		];
		const risks = RiskAnalyzer.checkFileOverlap(subtasks);
		expect(risks[0]?.severity).toBe("high");
	});

	it("ignores non-path strings", () => {
		const subtasks = [
			makeSubtask("A", "Do something", "This is a plain description"),
			makeSubtask("B", "Do other thing", "No file references here"),
		];
		expect(RiskAnalyzer.checkFileOverlap(subtasks)).toEqual([]);
	});
});

// ── checkMissingTests ────────────────────────────────────────────────

describe("RiskAnalyzer.checkMissingTests", () => {
	it("returns empty when all packages have tests", () => {
		const existingTests = new Set([
			"packages/loop/briefing/dag.test.ts",
			"packages/core/config/config.test.ts",
		]);
		const risks = RiskAnalyzer.checkMissingTests(
			["packages/loop", "packages/core"],
			existingTests,
		);
		expect(risks).toEqual([]);
	});

	it("flags packages with no test files", () => {
		const existingTests = new Set(["packages/loop/briefing/dag.test.ts"]);
		const risks = RiskAnalyzer.checkMissingTests(
			["packages/loop", "packages/dashboard"],
			existingTests,
		);
		expect(risks.length).toBe(1);
		expect(risks[0]?.type).toBe("no_tests");
		expect(risks[0]?.message).toContain("packages/dashboard");
	});
});

// ── checkLargeScope ──────────────────────────────────────────────────

describe("RiskAnalyzer.checkLargeScope", () => {
	it("returns empty for small scope", () => {
		expect(RiskAnalyzer.checkLargeScope(5)).toEqual([]);
		expect(RiskAnalyzer.checkLargeScope(10)).toEqual([]);
	});

	it("returns medium for 11-20 subtasks", () => {
		const risks = RiskAnalyzer.checkLargeScope(15);
		expect(risks[0]?.severity).toBe("medium");
		expect(risks[0]?.type).toBe("large_scope");
	});

	it("returns high for >20 subtasks", () => {
		expect(RiskAnalyzer.checkLargeScope(25)[0]?.severity).toBe("high");
	});
});

// ── checkPastThrash ──────────────────────────────────────────────────

describe("RiskAnalyzer.checkPastThrash", () => {
	it("returns empty with no reopens", () => {
		expect(
			RiskAnalyzer.checkPastThrash([makeCompleted("A"), makeCompleted("B")]),
		).toEqual([]);
	});

	it("ignores single reopens", () => {
		expect(
			RiskAnalyzer.checkPastThrash([makeCompleted("A"), makeReopen("A")]),
		).toEqual([]);
	});

	it("detects medium thrash at 2 reopens", () => {
		const risks = RiskAnalyzer.checkPastThrash([
			makeReopen("A"),
			makeReopen("A"),
		]);
		expect(risks[0]?.severity).toBe("medium");
		expect(risks[0]?.type).toBe("past_thrash");
	});

	it("detects high thrash at 3+ reopens", () => {
		const risks = RiskAnalyzer.checkPastThrash([
			makeReopen("A"),
			makeReopen("A"),
			makeReopen("A"),
		]);
		expect(risks[0]?.severity).toBe("high");
	});

	it("tracks multiple subtasks independently", () => {
		const risks = RiskAnalyzer.checkPastThrash([
			makeReopen("A"),
			makeReopen("A"),
			makeReopen("B"),
			makeReopen("B"),
			makeReopen("B"),
		]);
		expect(risks.length).toBe(2);
		expect(risks.map((r) => r.severity).sort()).toEqual(["high", "medium"]);
	});
});

// ── checkVagueDescription ────────────────────────────────────────────

describe("RiskAnalyzer.checkVagueDescription", () => {
	it("flags empty description as high severity", () => {
		const risks = RiskAnalyzer.checkVagueDescription([
			makeSubtask("A", "Do x"),
		]);
		expect(risks[0]?.severity).toBe("high");
		expect(risks[0]?.type).toBe("vague_description");
	});

	it("flags short description as medium severity", () => {
		const risks = RiskAnalyzer.checkVagueDescription([
			makeSubtask("A", "Do x", "Short note"),
		]);
		expect(risks[0]?.severity).toBe("medium");
	});

	it("flags long description with no file paths as low severity", () => {
		const risks = RiskAnalyzer.checkVagueDescription([
			makeSubtask(
				"A",
				"Do x",
				longDescription(
					"This is a sufficiently long description but no concrete file targets",
				),
			),
		]);
		expect(risks[0]?.severity).toBe("low");
	});

	it("accepts long description that mentions file paths", () => {
		const risks = RiskAnalyzer.checkVagueDescription([
			makeSubtask(
				"A",
				"Do x",
				longDescription(
					"Update `packages/foo/bar.ts` and run tests against it",
				),
			),
		]);
		expect(risks).toEqual([]);
	});
});

// ── checkUnreviewableScope ───────────────────────────────────────────

describe("RiskAnalyzer.checkUnreviewableScope", () => {
	it("ignores subtasks under the threshold", () => {
		const desc =
			"Touches `packages/a/x.ts`, `packages/b/y.ts`, `packages/c/z.ts`";
		expect(
			RiskAnalyzer.checkUnreviewableScope([makeSubtask("A", "Do x", desc)]),
		).toEqual([]);
	});

	it("flags subtasks above the threshold", () => {
		const desc = Array.from(
			{ length: 10 },
			(_, i) => `\`packages/p${i}/file.ts\``,
		).join(", ");
		const risks = RiskAnalyzer.checkUnreviewableScope([
			makeSubtask("A", "Do everything", desc),
		]);
		expect(risks.length).toBe(1);
		expect(risks[0]?.type).toBe("unreviewable_scope");
	});

	it("returns high severity for very wide scope", () => {
		const desc = Array.from(
			{ length: 20 },
			(_, i) => `\`packages/p${i}/file.ts\``,
		).join(" ");
		const risks = RiskAnalyzer.checkUnreviewableScope([
			makeSubtask("A", "Touch many files", desc),
		]);
		expect(risks[0]?.severity).toBe("high");
	});
});

// ── analyze (composite) ──────────────────────────────────────────────

describe("RiskAnalyzer.analyze", () => {
	it("combines all risk checks", () => {
		const result = RiskAnalyzer.analyze({
			subtasks: [
				makeSubtask(
					"A",
					"Schema work",
					longDescription("Modify `packages/loop/schemas/loop.ts`"),
				),
				makeSubtask(
					"B",
					"More schema work",
					longDescription("Also modify `packages/loop/schemas/loop.ts`"),
				),
			],
			progressEntries: [makeReopen("A"), makeReopen("A"), makeReopen("A")],
			existingTestFiles: new Set(["packages/loop/briefing/dag.test.ts"]),
			packagePaths: ["packages/loop", "packages/dashboard"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const types = result.value.map((r) => r.type);
		expect(types).toContain("file_overlap");
		expect(types).toContain("past_thrash");
		expect(types).toContain("no_tests");
	});

	it("sorts by severity (high first)", () => {
		const result = RiskAnalyzer.analyze({
			subtasks: Array.from({ length: 25 }, (_, i) =>
				makeSubtask(
					`T${i}`,
					`Task ${i}`,
					longDescription(`Edit \`packages/x/file${i}.ts\``),
				),
			),
			progressEntries: [makeReopen("T0")],
			existingTestFiles: new Set(),
			packagePaths: [],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value[0]?.severity).toBe("high");
	});

	it("returns empty for clean plan", () => {
		const result = RiskAnalyzer.analyze({
			subtasks: [
				makeSubtask(
					"A",
					"Foo work",
					longDescription("Edit `packages/loop/foo.ts` and add coverage"),
				),
				makeSubtask(
					"B",
					"Bar work",
					longDescription("Edit `packages/loop/bar.ts` and add coverage"),
				),
			],
			progressEntries: [],
			existingTestFiles: new Set(["packages/loop/test.test.ts"]),
			packagePaths: ["packages/loop"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual([]);
	});
});
