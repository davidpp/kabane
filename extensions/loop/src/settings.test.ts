import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@cabane/extension";
import type { LoopAdvice } from "./advice";
import { LoopConfig } from "./config";
import { loop } from "./extension";
import { LoopSettings } from "./settings";

const config = (input: LoopConfig.Input = {}): LoopConfig.Config => {
	const parsed = LoopConfig.Schema.safeParse(input);
	if (!parsed.success) throw parsed.error;
	return parsed.data;
};

describe("LoopSettings.inputs", () => {
	it("one input per setting the form can hold, read off the schema, grouped, at the config's values", () => {
		const inputs = LoopSettings.inputs(config(), ["functional", "quality"]);
		expect(Object.keys(inputs)).toEqual([
			"implementer",
			"model",
			"verifier",
			"budget.concurrency",
			"budget.continuations",
			"budget.spend",
			"stallAfter",
			"lenses.functional",
			"lenses.quality",
			"recheck",
			"worktree",
			"isolation",
			"reuse",
			"maxWorktrees",
			"land",
		]);
		// The gates are named commands the form cannot edit.
		expect(Object.keys(inputs).some((name) => name.startsWith("gates"))).toBe(
			false,
		);
		expect(inputs.verifier).toMatchObject({
			default: "implementer",
			options: ["implementer", "claude", "codex", "gemini"],
		});
		expect(inputs.worktree).toMatchObject({
			type: "boolean",
			default: true,
			group: "Workspace",
		});
		expect(inputs.land).toMatchObject({
			default: "none",
			options: ["none", "pr"],
			label: "land the branch",
			group: "Workspace",
		});
		// On by default, beside the lenses whose fixes it rechecks.
		expect(inputs.recheck).toMatchObject({
			type: "boolean",
			default: true,
			label: "recheck the fixes",
			group: "Checks",
		});
		expect(inputs["lenses.quality"]).toMatchObject({
			type: "boolean",
			default: false,
			label: "lens quality",
			group: "Checks",
		});
		expect(inputs.implementer).toMatchObject({
			default: "claude",
			options: ["claude", "codex", "gemini"],
			group: "Agents",
		});
		// No model is the user's own; the loop pins none.
		expect(inputs.model).toMatchObject({
			default: "your own",
			options: ["your own", "opus", "sonnet", "haiku"],
		});
		// Unset, it follows isolation; a value set in a layer shows instead.
		expect(inputs["budget.concurrency"]).toMatchObject({
			type: "number",
			default: "by isolation",
			label: "sessions at once",
			group: "Limits",
		});
		expect(inputs["budget.concurrency"]?.options?.slice(0, 3)).toEqual([
			"by isolation",
			"1",
			"2",
		]);
		expect(
			LoopSettings.inputs(config({ budget: { concurrency: 3 } }))[
				"budget.concurrency"
			]?.default,
		).toBe("3");
		expect(inputs.isolation).toMatchObject({
			default: "worktree",
			options: ["worktree", "shared"],
			group: "Workspace",
		});
		expect(inputs.reuse).toMatchObject({ type: "boolean", default: true });
		expect(inputs.maxWorktrees).toMatchObject({
			default: "one per session",
			group: "Workspace",
		});
		// The setup command is free text, which the form cannot hold.
		expect(inputs.setup).toBeUndefined();
		expect(inputs["budget.spend"]?.default).toBe("none");
	});

	it("a configured value that is not among the steps joins them, in order", () => {
		const inputs = LoopSettings.inputs(
			config({ model: "claude-opus-4", budget: { continuations: 4 } }),
		);
		expect(inputs.model?.default).toBe("claude-opus-4");
		expect(inputs.model?.options).toContain("claude-opus-4");
		expect(inputs["budget.continuations"]?.options).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4",
			"5",
			"10",
		]);
	});
});

describe("LoopSettings.overrides", () => {
	it("the form's values back as config, numbers as numbers, the unset options as absent", () => {
		const configured = config({ lenses: ["quality"] });
		const values = Object.fromEntries(
			Object.entries(
				LoopSettings.inputs(configured, ["functional", "quality"]),
			).map(([name, input]) => [name, input.default]),
		);
		const overrides = LoopSettings.overrides({
			...values,
			"budget.concurrency": "3",
			"lenses.functional": true,
			worktree: true,
		});
		expect(overrides).toEqual({
			ok: true,
			value: {
				implementer: "claude",
				model: undefined,
				budget: {
					concurrency: 3,
					continuations: 3,
					spend: undefined,
				},
				stallAfter: 3,
				recheck: true,
				worktree: true,
				isolation: "worktree",
				reuse: true,
				maxWorktrees: undefined,
				verifier: undefined,
				land: "none",
				lenses: ["functional", "quality"],
			},
		});
		// What the form starts from resolves to the config it was read from, with the changes.
		const resolved =
			overrides.ok && LoopConfig.Schema.safeParse(overrides.value);
		expect(resolved && resolved.success && resolved.data).toEqual({
			...configured,
			budget: { ...configured.budget, concurrency: 3 },
			worktree: true,
			lenses: ["functional", "quality"],
		});
	});

	it("only the values given, and a value that is no number is refused", () => {
		expect(LoopSettings.overrides({ stallAfter: "2" })).toEqual({
			ok: true,
			value: { stallAfter: 2 },
		});
		expect(LoopSettings.overrides({ stallAfter: "soon" }).ok).toBe(false);
	});
});

describe("the loop's looks", () => {
	const fieldAt = (path: string) => {
		const found = Settings.fields(LoopConfig.Schema).find(
			(f) => f.path.join(".") === path,
		);
		if (!found) throw new Error(path);
		return found;
	};
	const optionsAt = (path: string, at: Settings.At = {}) =>
		Settings.options(
			fieldAt(path),
			Settings.lookOf(loop.looks, path.split(".")),
			at,
		);

	it("are declared on the extension, and their groups are the form's sections in order", () => {
		expect(
			Settings.lookOf(loop.looks, ["budget", "concurrency"]),
		).toMatchObject({
			label: "sessions at once",
			group: "Limits",
		});
		expect(Settings.groupsOf(loop.looks)).toEqual([
			"Agents",
			"Limits",
			"Checks",
			"Workspace",
		]);
	});

	it("a bound the schema states is the range stepped through", () => {
		expect(optionsAt("budget.concurrency")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(optionsAt("maxWorktrees")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("the lenses come from what the project offers", () => {
		expect(optionsAt("lenses")).toEqual(["functional", "quality"]);
		const repo = mkdtempSync(join(tmpdir(), "loop-looks-"));
		try {
			const lenses = join(
				repo,
				".claude",
				"skills",
				"dispatch",
				"references",
				"lenses",
			);
			mkdirSync(lenses, { recursive: true });
			writeFileSync(join(lenses, "security.md"), "Review security.");
			expect(optionsAt("lenses", { projectDir: repo })).toEqual([
				"functional",
				"quality",
				"security",
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

it("an advised hint names no previous value when it is only the schema default", () => {
	const advice = [
		{ path: "stallAfter", value: 2, reason: "thrash" },
	] satisfies LoopAdvice.Recommendation[];
	expect(LoopSettings.inputs(config({}), [], advice).stallAfter?.hint).toBe(
		"advised: thrash",
	);
	expect(
		LoopSettings.inputs(config({ stallAfter: 5 }), [], advice).stallAfter?.hint,
	).toBe("advised: thrash (your setting: 5)");
});

it("advice replaces task settings with a reason, preserves preferences, and user edits win", () => {
	const original = config({
		implementer: "codex",
		verifier: "claude",
		model: "chosen",
		land: "pr",
		budget: { concurrency: 3 },
	});
	const advice = [
		{ path: "budget.concurrency", value: 1, reason: "shared files" },
		{
			path: "gates",
			value: { test: "bun run test" },
			reason: "project script",
		},
		{ path: "setup", value: "bun install", reason: "lockfile" },
	] satisfies LoopAdvice.Recommendation[];
	const inputs = LoopSettings.inputs(original, [], advice);
	expect(inputs["budget.concurrency"]).toMatchObject({
		default: "1",
		hint: "advised: shared files (your setting: 3)",
	});
	expect(inputs.implementer?.default).toBe("codex");
	expect(inputs.verifier?.default).toBe("claude");
	expect(inputs.model?.default).toBe("chosen");
	expect(inputs.land?.default).toBe("pr");
	expect(LoopSettings.overrides({ "budget.concurrency": "4" }, advice)).toEqual(
		{
			ok: true,
			value: {
				budget: { concurrency: 4 },
				gates: { test: "bun run test" },
				setup: "bun install",
			},
		},
	);
	expect(original.budget.concurrency).toBe(3);
});
