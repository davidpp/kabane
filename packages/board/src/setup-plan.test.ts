import { describe, expect, test } from "bun:test";
import { SetupPlan } from "./setup-plan";

const REPO: SetupPlan.Repo = {
	root: "/work/cabane",
	scopeId: "github.com/acme/cabane",
	name: "cabane",
};

const DEFAULTS: SetupPlan.Defaults = {
	name: "david",
	device: "mbp",
	harnesses: [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
	repo: REPO,
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
	test("name, device, one row per harness, then the pin", () => {
		expect(SetupPlan.fields(DEFAULTS).map((f) => f.kind)).toEqual([
			"name",
			"device",
			"harness",
			"harness",
			"pin",
		]);
	});

	test("no repo, no pin row; no harness, no harness rows", () => {
		expect(
			SetupPlan.fields({ ...DEFAULTS, harnesses: [], repo: null }).map(
				(f) => f.kind,
			),
		).toEqual(["name", "device"]);
	});
});

describe("plan", () => {
	test("accepting the defaults wires every detected harness and pins nothing", () => {
		const planned = SetupPlan.plan(answer(), DEFAULTS);
		expect(planned).toEqual({
			ok: true,
			value: {
				actor: "cabane://actor/human/david",
				deviceId: "mbp",
				install: ["claude", "codex"],
				pin: null,
			},
		});
	});

	test("space on a harness row unchecks it; on the pin row it pins", () => {
		const form = answer(down, down, space, up, up, up, space);
		const planned = SetupPlan.plan(form, DEFAULTS);
		expect(planned.ok && planned.value.install).toEqual(["codex"]);
		expect(planned.ok && planned.value.pin).toEqual(REPO);
	});

	test("install order follows detection, not the order boxes were ticked", () => {
		// Both off, then codex back on before claude.
		const form = answer(down, down, space, down, space, space, up, space);
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
			"cabane://actor/human/david-paquet",
		);
	});

	test("a name with nothing sluggable, or an empty device, is refused", () => {
		const noName = SetupPlan.plan({ ...answer(), name: " ?! " }, DEFAULTS);
		expect(noName.ok).toBe(false);
		const noDevice = SetupPlan.plan({ ...answer(), device: "  " }, DEFAULTS);
		expect(noDevice.ok).toBe(false);
	});
});

describe("moveFocus", () => {
	test("wraps both ways", () => {
		expect(answer(up).focus).toBe(4);
		expect(answer(up, down).focus).toBe(0);
	});
});
