// The trigger form through the board's own routers: the picker opens it on a trigger the board can
// fill in, its keys and clicks move fields and values, and `enter` fires with what was set.
import { describe, expect, test } from "bun:test";
import type { TriggerDescriptor } from "@kabane/extension";
import { BoardNav } from "./nav";
import { TriggerForm } from "./trigger-form";

const START: TriggerDescriptor = {
	id: "loop:start",
	label: "start loop",
	satisfiable: true,
	inputs: {
		implementer: {
			type: "string",
			required: false,
			default: "claude",
			options: ["claude", "codex", "gemini"],
			group: "Agents",
		},
		concurrency: {
			type: "number",
			required: false,
			default: 2,
			options: ["1", "2", "3"],
			group: "Limits",
		},
		wall: { type: "number", required: false, default: 0, group: "Limits" },
		worktree: { type: "boolean", required: false, default: false },
	},
	preview: [[{ text: "Plan", bold: true }]],
};

const PLAIN: TriggerDescriptor = {
	id: "claude",
	label: "claude",
	satisfiable: true,
	inputs: {},
};

const picker = (triggers: TriggerDescriptor[]): BoardNav.BoardState => ({
	...BoardNav.init([], { scoped: false }),
	dispatch: { taskId: "t1", triggers, selected: 0, loading: false },
});

const keys = (
	state: BoardNav.BoardState,
	...names: string[]
): { state: BoardNav.BoardState; effect: BoardNav.Effect } => {
	let step: { state: BoardNav.BoardState; effect: BoardNav.Effect } = {
		state,
		effect: { type: "none" },
	};
	for (const name of names) step = BoardNav.reduceKey(step.state, { name }, 0);
	return step;
};

describe("TriggerForm.fillable", () => {
	test("any trigger with inputs: what h/l cannot step is typed", () => {
		expect(TriggerForm.fillable(START)).toBe(true);
		expect(TriggerForm.fillable(PLAIN)).toBe(false);
		const typed = (input: TriggerDescriptor["inputs"][string]) =>
			TriggerForm.typed(input);
		expect(typed({ type: "string", required: true, default: "x" })).toBe(true);
		expect(typed({ type: "number", required: false })).toBe(true);
		expect(typed({ type: "number", required: false, default: 1 })).toBe(false);
		expect(
			typed({ type: "string", required: false, options: ["a", "b"] }),
		).toBe(false);
	});
});

describe("TriggerForm.step", () => {
	test("options wrap both ways, numbers stop at zero, booleans flip", () => {
		const options = { type: "string", required: false, options: ["a", "b"] };
		expect(TriggerForm.step(options, "b", 1)).toBe("a");
		expect(TriggerForm.step(options, "a", -1)).toBe("b");
		const number = { type: "number", required: false };
		expect(TriggerForm.step(number, 0, -1)).toBe(0);
		expect(TriggerForm.step(number, 4, 1)).toBe(5);
		expect(
			TriggerForm.step({ type: "boolean", required: false }, true, 1),
		).toBe(false);
	});
});

describe("the form on the board", () => {
	test("enter on a fillable trigger opens its form at the defaults instead of firing", () => {
		const { state, effect } = keys(picker([START]), "return");
		expect(effect).toEqual({ type: "none" });
		expect(state.dispatch?.form).toEqual({
			trigger: START,
			field: 0,
			values: {
				implementer: "claude",
				concurrency: 2,
				wall: 0,
				worktree: false,
			},
			edited: [],
		});
		expect(BoardNav.keyContext(state)).toBe("dispatchForm");
	});

	test("a trigger without inputs still fires straight from the picker", () => {
		const { state, effect } = keys(picker([PLAIN]), "return");
		expect(state.dispatch).toBeNull();
		expect(effect).toEqual({ type: "dispatch", triggerId: "claude", id: "t1" });
	});

	test("j/k move between fields and stop at the ends; h/l change the field in hand", () => {
		const opened = keys(picker([START]), "return").state;
		expect(keys(opened, "k").state.dispatch?.form?.field).toBe(0);
		const last = keys(opened, "j", "j", "j", "j").state;
		expect(last.dispatch?.form?.field).toBe(3);
		const changed = keys(opened, "j", "l", "j", "h", "j", "l").state;
		expect(changed.dispatch?.form?.values).toEqual({
			implementer: "claude",
			concurrency: "3",
			wall: 0,
			worktree: true,
		});
		const form = changed.dispatch?.form;
		expect(form && TriggerForm.changed(form, "concurrency")).toBe(true);
		expect(form && TriggerForm.changed(form, "implementer")).toBe(false);
	});

	test("enter fires the trigger on the task with every value and closes the overlay", () => {
		const { state, effect } = keys(
			picker([START]),
			"return",
			"j",
			"l",
			"return",
		);
		expect(state.dispatch).toBeNull();
		expect(effect).toEqual({
			type: "dispatch",
			triggerId: "loop:start",
			id: "t1",
			inputs: {
				implementer: "claude",
				concurrency: "3",
				wall: 0,
				worktree: false,
			},
			edited: ["concurrency"],
		});
	});

	test("a value stepped away and back is still the human's: edited names it", () => {
		const { state, effect } = keys(picker([START]), "return", "j", "l", "h");
		expect(state.dispatch?.form?.edited).toEqual(["concurrency"]);
		expect(effect).toEqual({ type: "none" });
		expect(keys(state, "return").effect).toMatchObject({
			inputs: { concurrency: "2" },
			edited: ["concurrency"],
		});
	});

	test("esc goes back to the picker with the trigger still selected, then closes it", () => {
		const back = keys(picker([PLAIN, START]), "j", "return", "escape").state;
		expect(back.dispatch?.form).toBeUndefined();
		expect(back.dispatch?.selected).toBe(1);
		expect(BoardNav.keyContext(back)).toBe("dispatch");
		expect(keys(back, "escape").state.dispatch).toBeNull();
	});

	test("a click focuses a field, and a second click on it changes its value", () => {
		const opened = keys(picker([START]), "return").state;
		const focused = BoardNav.reduceMouse(opened, {
			type: "formField",
			index: 3,
		}).state;
		expect(focused.dispatch?.form?.field).toBe(3);
		expect(focused.dispatch?.form?.values.worktree).toBe(false);
		const flipped = BoardNav.reduceMouse(focused, {
			type: "formField",
			index: 3,
		}).state;
		expect(flipped.dispatch?.form?.values.worktree).toBe(true);
		// No form open: the click does nothing.
		const none = picker([START]);
		expect(
			BoardNav.reduceMouse(none, { type: "formField", index: 1 }).state,
		).toBe(none);
	});

	test("a typed field takes letters, backspace and up/down; h/l and j/k are its characters", () => {
		const trigger: TriggerDescriptor = {
			id: "recipe:probe",
			label: "probe",
			satisfiable: true,
			inputs: {
				"@harness": {
					type: "string",
					required: true,
					default: "claude",
					label: "harness",
				},
				topic: { type: "string", required: true },
				depth: { type: "number", required: false, default: 2 },
			},
		};
		const opened = keys(picker([trigger]), "return").state;
		expect(opened.dispatch?.form?.values).toEqual({
			"@harness": "claude",
			topic: "",
			depth: 2,
		});
		expect(
			BoardNav.keySituation(opened, { linked: new Set(), events: false }),
		).toMatchObject({ formTyping: true });
		const typed = keys(opened, "backspace", "backspace", "backspace").state;
		const sent = ["j", "l", " ", "h", "k"].reduce(
			(state, char) =>
				BoardNav.reduceKey(state, { name: char, sequence: char }, 0).state,
			typed,
		);
		expect(sent.dispatch?.form?.values["@harness"]).toBe("clajl hk");
		expect(sent.dispatch?.form?.field).toBe(0);
		const form = sent.dispatch?.form;
		expect(form && TriggerForm.changed(form, "@harness")).toBe(true);
		expect(keys(sent, "down").state.dispatch?.form?.field).toBe(1);
	});

	test("enter with a required typed field empty focuses it and says so; filled, it fires", () => {
		const trigger: TriggerDescriptor = {
			id: "recipe:probe",
			label: "probe",
			satisfiable: true,
			inputs: {
				"@harness": { type: "string", required: true, default: "claude" },
				topic: { type: "string", required: true, label: "Topic" },
			},
		};
		const opened = keys(picker([trigger]), "return").state;
		const refused = keys(opened, "return");
		expect(refused.state.dispatch?.form?.field).toBe(1);
		expect(refused.effect).toEqual({
			type: "notice",
			notice: { text: "Topic is required", tone: "error" },
		});
		const filled = BoardNav.reduceKey(
			refused.state,
			{ name: "x", sequence: "x" },
			0,
		).state;
		expect(keys(filled, "return").effect).toEqual({
			type: "dispatch",
			triggerId: "recipe:probe",
			id: "t1",
			inputs: { "@harness": "claude", topic: "x" },
			edited: ["topic"],
		});
	});
});
