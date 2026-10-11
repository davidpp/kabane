import { describe, expect, it } from "bun:test";
import { LoopConfig } from "./config";
import { LoopSettings } from "./settings";

const config = (input: LoopConfig.Input = {}): LoopConfig.Config => {
	const parsed = LoopConfig.Schema.safeParse(input);
	if (!parsed.success) throw parsed.error;
	return parsed.data;
};

describe("LoopSettings.inputs", () => {
	it("one input per setting the form can hold, read off the schema, at the config's values", () => {
		const inputs = LoopSettings.inputs(config());
		expect(Object.keys(inputs)).toEqual([
			"implementer",
			"model",
			"budget.concurrency",
			"budget.wallMinutes",
			"budget.continuations",
			"budget.spend",
			"stallAfter",
		]);
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
		expect(inputs["budget.concurrency"]).toMatchObject({
			type: "number",
			default: "2",
			label: "concurrent sessions",
			group: "Limits",
		});
		expect(inputs["budget.spend"]?.default).toBe("none");
	});

	it("a configured value that is not among the steps joins them, in order", () => {
		const inputs = LoopSettings.inputs(
			config({ model: "claude-opus-4", budget: { wallMinutes: 90 } }),
		);
		expect(inputs.model?.default).toBe("claude-opus-4");
		expect(inputs.model?.options).toContain("claude-opus-4");
		expect(inputs["budget.wallMinutes"]?.options).toEqual([
			"15",
			"30",
			"60",
			"90",
			"120",
			"240",
			"480",
		]);
	});
});

describe("LoopSettings.overrides", () => {
	it("the form's values back as config, numbers as numbers, the unset options as absent", () => {
		const values = Object.fromEntries(
			Object.entries(LoopSettings.inputs(config())).map(([name, input]) => [
				name,
				input.default,
			]),
		);
		const overrides = LoopSettings.overrides({
			...values,
			"budget.concurrency": "3",
		});
		expect(overrides).toEqual({
			ok: true,
			value: {
				implementer: "claude",
				model: undefined,
				budget: {
					concurrency: 3,
					wallMinutes: 120,
					continuations: 3,
					spend: undefined,
				},
				stallAfter: 3,
			},
		});
		// What the form starts from resolves to the config it was read from, with the one change.
		const resolved =
			overrides.ok && LoopConfig.Schema.safeParse(overrides.value);
		expect(resolved && resolved.success && resolved.data).toEqual({
			...config(),
			budget: { ...config().budget, concurrency: 3 },
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
