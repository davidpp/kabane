import { describe, expect, test } from "bun:test";
import { SetupPlan } from "./setup-plan";

const DEFAULTS: SetupPlan.Defaults = {
	name: "david",
	device: "mbp",
	harnesses: [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
	extensions: [],
	installOff: false,
	configPath: "~/.kabane/config.json",
};

// Scripted answers: a sequence of form edits applied from the defaults, as the screen would.
const answer = (
	...steps: ((form: SetupPlan.Form) => SetupPlan.Form)[]
): SetupPlan.Form =>
	steps.reduce((form, step) => step(form), SetupPlan.initialForm(DEFAULTS));
const down = (form: SetupPlan.Form) => SetupPlan.moveFocus(form, DEFAULTS, 1);
const up = (form: SetupPlan.Form) => SetupPlan.moveFocus(form, DEFAULTS, -1);
const space = (form: SetupPlan.Form) => SetupPlan.toggle(form, DEFAULTS);

describe("fields", () => {
	test("name, then one row per harness", () => {
		expect(SetupPlan.fields(DEFAULTS).map((f) => f.kind)).toEqual([
			"name",
			"harness",
			"harness",
		]);
	});

	test("no harness, no harness rows", () => {
		expect(
			SetupPlan.fields({ ...DEFAULTS, harnesses: [] }).map((f) => f.kind),
		).toEqual(["name"]);
	});
});

describe("plan", () => {
	test("accepting the defaults wires every detected harness", () => {
		const planned = SetupPlan.plan(answer(), DEFAULTS);
		expect(planned).toEqual({
			ok: true,
			value: {
				actor: "kabane://actor/human/david",
				deviceId: "mbp",
				install: ["claude", "codex"],
				extensions: [],
			},
		});
	});

	test("space on a harness row unchecks it", () => {
		const form = answer(down, space);
		const planned = SetupPlan.plan(form, DEFAULTS);
		expect(planned.ok && planned.value.install).toEqual(["codex"]);
	});

	test("install order follows detection, not the order boxes were ticked", () => {
		// Both off, then codex back on before claude.
		const form = answer(down, space, down, space, space, up, space);
		expect(form.checked).toEqual(["codex", "claude"]);
		const planned = SetupPlan.plan(form, DEFAULTS);
		expect(planned.ok && planned.value.install).toEqual(["claude", "codex"]);
	});

	test("space on a text row changes nothing", () => {
		expect(answer(space)).toEqual(SetupPlan.initialForm(DEFAULTS));
	});

	test("a typed name becomes the actor slug", () => {
		const planned = SetupPlan.plan(
			{ ...answer(), name: "  David Paquet " },
			DEFAULTS,
		);
		expect(planned.ok && planned.value.actor).toBe(
			"kabane://actor/human/david-paquet",
		);
	});

	test("a name with nothing sluggable is refused", () => {
		const noName = SetupPlan.plan({ ...answer(), name: " ?! " }, DEFAULTS);
		expect(noName.ok).toBe(false);
	});
});

describe("moveFocus", () => {
	test("wraps both ways", () => {
		expect(answer(up).focus).toBe(2);
		expect(answer(up, down).focus).toBe(0);
	});
});

describe("the first issue", () => {
	const inProject = { ...DEFAULTS, project: "repo" };

	test("enter names the first checked agent, and only inside a project", () => {
		expect(SetupPlan.firstAgent(answer(), inProject)).toBe("claude");
		expect(SetupPlan.firstAgent(answer(down, space), inProject)).toBe("codex");
		expect(
			SetupPlan.firstAgent(answer(down, space, down, space), inProject),
		).toBe(undefined);
		expect(SetupPlan.firstAgent(answer(), DEFAULTS)).toBe(undefined);
	});

	test("it goes to the first agent whose install landed, never to one that failed", () => {
		const claudeFailed: SetupPlan.InstallOutcome[] = [
			{ id: "claude", status: "failed", message: "not logged in" },
			{ id: "codex", status: "already" },
		];
		expect(SetupPlan.firstIssueFor(claudeFailed, inProject)).toBe("codex");
		expect(
			SetupPlan.firstIssueFor([{ id: "claude", status: "failed" }], inProject),
		).toBe(undefined);
		expect(SetupPlan.firstIssueFor(claudeFailed, DEFAULTS)).toBe(undefined);
	});
});

describe("extensions", () => {
	const OFFERED: SetupPlan.Defaults = {
		...DEFAULTS,
		extensions: [
			{ name: "dispatch", description: "Serves the setup-dispatch skill." },
			{ name: "loop" },
		],
	};

	test("a step of their own after the form, one row each, none ticked", () => {
		const form = SetupPlan.initialForm(OFFERED);
		expect(SetupPlan.fields(OFFERED).map((f) => f.kind)).toEqual([
			"name",
			"harness",
			"harness",
		]);
		const next = SetupPlan.nextStep({ ...form, focus: 2 }, OFFERED);
		expect(next?.step).toBe("extensions");
		expect(next?.focus).toBe(0);
		expect(SetupPlan.fields(OFFERED, "extensions").map((f) => f.kind)).toEqual([
			"extension",
			"extension",
		]);
		expect(next && SetupPlan.nextStep(next, OFFERED)).toBeUndefined();
		expect(SetupPlan.nextStep(form, DEFAULTS)).toBeUndefined();
		const planned = SetupPlan.plan(form, OFFERED);
		expect(planned.ok && planned.value.extensions).toEqual([]);
	});

	test("space ticks one, focus wraps within the step, and the plan names them in offer order", () => {
		const step = SetupPlan.nextStep(SetupPlan.initialForm(OFFERED), OFFERED);
		if (!step) throw new Error("no extensions step");
		const loop = SetupPlan.toggle(
			SetupPlan.moveFocus(step, OFFERED, 1),
			OFFERED,
		);
		const both = SetupPlan.toggle(
			SetupPlan.moveFocus(loop, OFFERED, 1),
			OFFERED,
		);
		expect(both.focus).toBe(0);
		const planned = SetupPlan.plan(both, OFFERED);
		expect(planned.ok && planned.value.extensions).toEqual([
			"dispatch",
			"loop",
		]);
		expect(planned.ok && planned.value.install).toEqual(["claude", "codex"]);
		const untick = SetupPlan.plan(SetupPlan.toggle(both, OFFERED), OFFERED);
		expect(untick.ok && untick.value.extensions).toEqual(["loop"]);
	});
});
