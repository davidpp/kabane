// A trigger's settings, filled in on the board before it fires: the form `a` opens over a trigger
// whose every input it can hold (`fillable`). Plain functions over the board's state, like the other
// key routers, so the keys and the clicks are tested without a renderer.
//
// The form holds an input that starts from a default and that `h/l` can move: through its options,
// up and down for a number, on and off for a boolean. `j/k` walk the fields in the host's order,
// `enter` fires the trigger with every value, and `esc` goes back to the picker with the trigger
// still selected, one level per press like every other `esc` on the board.
import type { BoardNav } from "./nav";
import type { TriggerDescriptor, TriggerInput } from "./ports";

export namespace TriggerForm {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	export type Form = {
		trigger: TriggerDescriptor;
		// The field in hand, by its place in the trigger's inputs.
		field: number;
		// Every input's value, by name, from its default on.
		values: Readonly<Record<string, unknown>>;
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	/** An input the form can hold: it starts from a default, and `h/l` has somewhere to move it. */
	const holds = (input: TriggerInput): boolean =>
		input.default !== undefined &&
		((input.options?.length ?? 0) > 0 ||
			input.type === "number" ||
			input.type === "boolean");

	/** A trigger with inputs, every one of which the form can hold. */
	export const fillable = (trigger: TriggerDescriptor): boolean => {
		const inputs = Object.values(trigger.inputs);
		return inputs.length > 0 && inputs.every(holds);
	};

	/** The form over `trigger`, on its first field, every value at its default. */
	export const open = (trigger: TriggerDescriptor): Form => ({
		trigger,
		field: 0,
		values: Object.fromEntries(
			Object.entries(trigger.inputs).map(([name, input]) => [
				name,
				input.default,
			]),
		),
	});

	/** Whether the human moved `name` off its default. */
	export const changed = (form: Form, name: string): boolean =>
		form.values[name] !== form.trigger.inputs[name]?.default;

	/**
	 * `value` one step along: the next or previous option, wrapping; a number up or down, never
	 * below zero; a boolean flipped.
	 */
	export const step = (
		input: TriggerInput,
		value: unknown,
		by: 1 | -1,
	): unknown => {
		const options = input.options ?? [];
		if (options.length > 0) {
			const at = options.indexOf(String(value));
			return options[(at + by + options.length) % options.length];
		}
		if (input.type === "number" && typeof value === "number")
			return Math.max(0, value + by);
		if (input.type === "boolean") return value !== true;
		return value;
	};

	// No form is the picker under it, with the trigger still selected.
	const withForm = (state: State, form: Form | undefined): State =>
		state.dispatch
			? { ...state, dispatch: { ...state.dispatch, form } }
			: state;

	const names = (form: Form): string[] => Object.keys(form.trigger.inputs);

	const focus = (state: State, form: Form, field: number): Step => {
		const last = names(form).length - 1;
		const next = Math.max(0, Math.min(last, field));
		return next === form.field
			? { state, effect: NOTHING }
			: { state: withForm(state, { ...form, field: next }), effect: NOTHING };
	};

	const change = (state: State, form: Form, by: 1 | -1): Step => {
		const name = names(form)[form.field];
		const input = name === undefined ? undefined : form.trigger.inputs[name];
		if (name === undefined || input === undefined)
			return { state, effect: NOTHING };
		const values = {
			...form.values,
			[name]: step(input, form.values[name], by),
		};
		return { state: withForm(state, { ...form, values }), effect: NOTHING };
	};

	/** `enter`: the picker closes and the trigger fires on the task with the form's values. */
	const fire = (state: State, form: Form): Step => {
		const taskId = state.dispatch?.taskId;
		if (taskId === undefined) return { state, effect: NOTHING };
		return {
			state: { ...state, dispatch: null },
			effect: {
				type: "dispatch",
				triggerId: form.trigger.id,
				id: taskId,
				inputs: form.values,
			},
		};
	};

	/** The form's keys. It is modal: every other key does nothing while it is open. */
	export const reduceKey = (
		state: State,
		form: Form,
		key: BoardNav.KeyInput,
	): Step => {
		switch (key.name) {
			case "escape":
				return { state: withForm(state, undefined), effect: NOTHING };
			case "j":
			case "down":
				return focus(state, form, form.field + 1);
			case "k":
			case "up":
				return focus(state, form, form.field - 1);
			case "l":
			case "right":
				return change(state, form, 1);
			case "h":
			case "left":
				return change(state, form, -1);
			case "return":
			case "enter":
				return fire(state, form);
			default:
				return { state, effect: NOTHING };
		}
	};

	/**
	 * A click on the `index`th field: it takes the focus, and a click on the field already in hand
	 * moves its value on, as `l` does (the board's click-then-click, with no double-click timing).
	 */
	export const click = (state: State, index: number): Step => {
		const form = state.dispatch?.form;
		if (!form) return { state, effect: NOTHING };
		return index === form.field
			? change(state, form, 1)
			: focus(state, form, index);
	};
}
