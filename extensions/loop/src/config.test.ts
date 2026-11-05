import { describe, expect, it } from "bun:test";
import { Settings } from "@cabane/extension";
import { LoopConfig } from "./config";

// The loop's settings schema through the resolver every namespace shares. Where each layer is
// stored is the CLI's (config-layers.test.ts); this is what the loop accepts in one.
const PROJECT = "/repo/.kabane/loop.json";

const resolve = (
	project: unknown,
	overrides?: Readonly<Record<string, unknown>>,
) =>
	Settings.resolve(LoopConfig.NAMESPACE, LoopConfig.SettingsSchema, [
		...(project === undefined
			? []
			: [{ layer: "project" as const, label: PROJECT, value: project }]),
		...(overrides
			? [{ layer: "caller" as const, label: Settings.CALLER, value: overrides }]
			: []),
	]);

const refusal = (
	project: unknown,
	overrides?: Readonly<Record<string, unknown>>,
): string => {
	const resolved = resolve(project, overrides);
	return resolved.ok ? "accepted" : resolved.error.message;
};

describe("LoopConfig.SettingsSchema", () => {
	it("is the defaults with no layer", () => {
		const config = resolve(undefined);
		expect(config.ok && config.value.value).toEqual({
			implementer: "claude",
			budget: {
				concurrency: 2,
				continuations: 3,
				currency: "USD",
			},
			stallAfter: 3,
			gates: {},
			worktree: true,
			lenses: [],
		});
	});

	it("layers overrides over the project file key by key, budget and gates included", () => {
		const config = resolve(
			{
				implementer: "codex",
				budget: { concurrency: 4, continuations: 2 },
				gates: { test: "bun test" },
			},
			{
				budget: { continuations: 5 },
				stallAfter: 2,
				gates: { lint: "bun run check" },
			},
		);
		expect(config.ok).toBe(true);
		if (!config.ok) return;
		expect(config.value.value.implementer).toBe("codex");
		expect(config.value.value.budget).toEqual({
			concurrency: 4,
			continuations: 5,
			currency: "USD",
		});
		expect(config.value.value.stallAfter).toBe(2);
		expect(config.value.value.gates).toEqual({
			test: "bun test",
			lint: "bun run check",
		});
	});

	it("drops the retired timer from existing files and saved runs", () => {
		const legacy = { budget: { concurrency: 4, wallMinutes: 120 } };
		const resolved = resolve(legacy);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.value.value.budget.concurrency).toBe(4);
			expect(resolved.value.value.budget).not.toHaveProperty("wallMinutes");
		}
		const saved = LoopConfig.Schema.safeParse(legacy);
		expect(saved.success).toBe(true);
		if (saved.success)
			expect(saved.data.budget).not.toHaveProperty("wallMinutes");
	});

	it("refuses gates or a budget that is not an object, rather than reading it as none", () => {
		// What the CLI passes when no flag sets either.
		expect(
			refusal({ gates: ["bun test"] }, { budget: {}, gates: {} }),
		).toContain("\n  gates: Expected object, received array");
		expect(refusal({ budget: 30 })).toContain(
			"\n  budget: Expected object, received number",
		);
		expect(refusal({}, { gates: "bun test" })).toContain(
			`${Settings.CALLER}:\n  gates: Expected object, received string`,
		);
	});

	it("refuses a key no setting has, one line per key, naming the layer", () => {
		expect(
			refusal({
				workTree: true,
				lens: ["quality"],
				budget: { wallMinute: 5 },
			}),
		).toBe(
			[
				`Invalid loop settings in ${PROJECT}:`,
				"  budget.wallMinute: not a loop setting",
				"  workTree: not a loop setting",
				"  lens: not a loop setting",
			].join("\n"),
		);
		// An unset names a setting too: a typo set to null is still a typo.
		expect(
			refusal({
				workTree: null,
				budget: { wallMinute: null },
				gates: { "two words": null },
			}),
		).toBe(
			[
				`Invalid loop settings in ${PROJECT}:`,
				"  workTree: not a loop setting",
				"  budget.wallMinute: not a loop setting",
				"  gates.two words: a gate name is one word",
			].join("\n"),
		);
		// A device key is not a loop setting either, so a checked-in file cannot reach the hub.
		expect(refusal({ sync: { url: "https://elsewhere" } })).toBe(
			`Invalid loop settings in ${PROJECT}:\n  sync: not a loop setting`,
		);
	});
});
