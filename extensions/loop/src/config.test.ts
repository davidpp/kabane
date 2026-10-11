import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopConfig } from "./config";

let repo = "";

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "loop-config-"));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const writeRepoFile = (content: string) => {
	mkdirSync(join(repo, ".kabane"), { recursive: true });
	writeFileSync(join(repo, LoopConfig.FILE), content);
};

describe("LoopConfig.resolve", () => {
	it("is the defaults with no repo file and no overrides", () => {
		const config = LoopConfig.resolve(repo);
		expect(config.ok && config.value).toEqual({
			implementer: "claude",
			budget: {
				concurrency: 2,
				wallMinutes: 120,
				continuations: 3,
				currency: "USD",
			},
			stallAfter: 3,
			gates: {},
			worktree: false,
			lenses: [],
		});
	});

	it("layers overrides over the repo file key by key, budget included", () => {
		writeRepoFile(
			JSON.stringify({
				implementer: "codex",
				budget: { concurrency: 4, wallMinutes: 30 },
				gates: { test: "bun test" },
			}),
		);
		const config = LoopConfig.resolve(repo, {
			budget: { wallMinutes: 5 },
			stallAfter: 2,
			gates: { lint: "bun run check" },
		});
		expect(config.ok).toBe(true);
		if (!config.ok) return;
		expect(config.value.implementer).toBe("codex");
		expect(config.value.budget).toEqual({
			concurrency: 4,
			wallMinutes: 5,
			continuations: 3,
			currency: "USD",
		});
		expect(config.value.stallAfter).toBe(2);
		expect(config.value.gates).toEqual({
			test: "bun test",
			lint: "bun run check",
		});
	});

	it("names the repo file when it is not JSON or the result is invalid", () => {
		writeRepoFile("{ nope");
		const broken = LoopConfig.resolve(repo);
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error.message).toContain("loop.json");

		writeRepoFile(JSON.stringify({ implementer: "hermes" }));
		const unknown = LoopConfig.resolve(repo);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.message).toContain("loop.json");
	});

	const refusal = (overrides: LoopConfig.Overrides = {}): string => {
		const config = LoopConfig.resolve(repo, overrides);
		return config.ok ? "accepted" : config.error.message;
	};

	it("refuses gates or a budget that is not an object, rather than reading it as none", () => {
		writeRepoFile(JSON.stringify({ gates: ["bun test"] }));
		// What the CLI passes when no flag sets either.
		expect(refusal({ budget: {}, gates: {} })).toContain(
			"\n  gates: Expected object, received array",
		);
		writeRepoFile(JSON.stringify({ budget: 30 }));
		expect(refusal()).toContain("\n  budget: Expected object, received number");
		writeRepoFile("{}");
		expect(refusal({ gates: "bun test" })).toContain(
			"the given overrides:\n  gates: Expected object, received string",
		);
	});

	it("refuses a key no setting has, one line per key, naming the file", () => {
		writeRepoFile(
			JSON.stringify({
				workTree: true,
				lens: ["quality"],
				budget: { wallMinute: 5 },
			}),
		);
		expect(refusal()).toBe(
			[
				`Invalid loop config in ${join(repo, LoopConfig.FILE)}:`,
				"  budget.wallMinute: not a loop setting",
				"  workTree: not a loop setting",
				"  lens: not a loop setting",
			].join("\n"),
		);
	});
});
