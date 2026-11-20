// A trigger's settings, filled in on the board before it fires: the form `a` opens over any trigger
// with inputs (`fillable`). Plain functions over the board's state, like the other key routers, so
// the keys and the clicks are tested without a renderer.
//
// `h/l` move an input that has somewhere to go: through its options, up and down for a number with
// a default, on and off for a boolean with one. Every other input is typed: in hand, a printable
// key adds to it, `backspace` takes the last character off, and `up/down` leave it, since `j/k`
// are letters it takes. `j/k` walk the fields in the host's order, `enter` fires the trigger with
// every value unless a required one is empty, and `esc` goes back to the picker with the trigger
// still selected, one level per press like every other `esc` on the board.
import type { TriggerDescriptor, TriggerInput } from "@kabane/extension";
import { Grid } from "./grid";
import type { BoardNav } from "./nav";

export namespace TriggerForm {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	export type Form = {
		trigger: TriggerDescriptor;
		// The field in hand, by its place in the trigger's inputs.
		field: number;
		// Every input's value, by name, from its default on.
		values: Readonly<Record<string, unknown>>;
		// The inputs the human has moved, those moved back to their default included.
		edited: readonly string[];
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	/** An input `h/l` has somewhere to move: options, or a number or boolean from a default. */
	const steps = (input: TriggerInput): boolean =>
		(input.options?.length ?? 0) > 0 ||
		(input.default !== undefined &&
			(input.type === "number" || input.type === "boolean"));

	/** An input the human types: every one `h/l` cannot move. Its value is the text as typed. */
	export const typed = (input: TriggerInput): boolean => !steps(input);

	/** A trigger with inputs: the form holds every one, stepped or typed. */
	export const fillable = (trigger: TriggerDescriptor): boolean =>
		Object.keys(trigger.inputs).length > 0;

	/** Where a field starts: its default, or an empty text for a typed one without. */
	const initial = (input: TriggerInput): unknown =>
		input.default ?? (typed(input) ? "" : undefined);

	/** The form over `trigger`, on its first field, every value at its default. */
	export const open = (trigger: TriggerDescriptor): Form => ({
		trigger,
		field: 0,
		values: Object.fromEntries(
			Object.entries(trigger.inputs).map(([name, input]) => [
				name,
				initial(input),
			]),
		),
		edited: [],
	});

	/** Whether the human moved `name` off its default. */
	export const changed = (form: Form, name: string): boolean => {
		const input = form.trigger.inputs[name];
		return input !== undefined && form.values[name] !== initial(input);
	};

	/** What the keys and the footer go by: whether the field in hand is typed. */
	export const situation = (form: Form): { formTyping: boolean } => {
		const input = inHand(form)?.input;
		return { formTyping: input !== undefined && typed(input) };
	};

	/** What `step` moves through: a trigger's input, or a setting's field and looked-up steps. */
	export type Steps = {
		type: string;
		options?: readonly (string | number)[] | undefined;
	};

	/**
	 * `value` one step along: the next or previous option, wrapping; a number up or down, never
	 * below zero; a boolean flipped. The settings view steps a setting with it too.
	 */
	export const step = (
		input: TriggerInput | Steps,
		value: unknown,
		by: 1 | -1,
	): unknown => {
		const options = input.options ?? [];
		if (options.length > 0) {
			const at = options.findIndex(
				(option) => String(option) === String(value),
			);
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

	const inHand = (
		form: Form,
	): { name: string; input: TriggerInput } | undefined => {
		const name = names(form)[form.field];
		const input = name === undefined ? undefined : form.trigger.inputs[name];
		return name === undefined || input === undefined
			? undefined
			: { name, input };
	};

	const focus = (state: State, form: Form, field: number): Step => {
		const last = names(form).length - 1;
		const next = Math.max(0, Math.min(last, field));
		return next === form.field
			? { state, effect: NOTHING }
			: { state: withForm(state, { ...form, field: next }), effect: NOTHING };
	};

	const set = (
		state: State,
		form: Form,
		name: string,
		value: unknown,
	): Step => {
		const values = { ...form.values, [name]: value };
		const edited = form.edited.includes(name)
			? form.edited
			: [...form.edited, name];
		return {
			state: withForm(state, { ...form, values, edited }),
			effect: NOTHING,
		};
	};

	const change = (state: State, form: Form, by: 1 | -1): Step => {
		const field = inHand(form);
		return field === undefined
			? { state, effect: NOTHING }
			: set(
					state,
					form,
					field.name,
					step(field.input, form.values[field.name], by),
				);
	};

	/** A key on a typed field: a character added, the last one taken off, or undefined for neither. */
	const type = (
		state: State,
		form: Form,
		name: string,
		key: BoardNav.KeyInput,
	): Step | undefined => {
		const text = String(form.values[name] ?? "");
		if (key.name === "backspace")
			return text === ""
				? undefined
				: set(state, form, name, text.slice(0, -1));
		const char = Grid.printable(key);
		return char === undefined ? undefined : set(state, form, name, text + char);
	};

	/**
	 * `enter`: the picker closes and the trigger fires on the task with the form's values. A required
	 * field left empty takes the focus instead, with a notice that names it.
	 */
	const fire = (state: State, form: Form): Step => {
		const taskId = state.dispatch?.taskId;
		if (taskId === undefined) return { state, effect: NOTHING };
		const empty = names(form).findIndex((name) => {
			const value = form.values[name];
			return (
				form.trigger.inputs[name]?.required === true &&
				(value === undefined || value === "")
			);
		});
		if (empty !== -1) {
			const name = names(form)[empty] ?? "";
			return {
				state: withForm(state, { ...form, field: empty }),
				effect: {
					type: "notice",
					notice: {
						text: `${form.trigger.inputs[name]?.label ?? name} is required`,
						tone: "error",
					},
				},
			};
		}
		return {
			state: { ...state, dispatch: null },
			effect: {
				type: "dispatch",
				triggerId: form.trigger.id,
				id: taskId,
				inputs: form.values,
				edited: form.edited,
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
			case "return":
			case "enter":
				return fire(state, form);
		}
		const field = inHand(form);
		if (field !== undefined && typed(field.input)) {
			if (key.name === "up" || key.name === "down")
				return focus(state, form, form.field + (key.name === "down" ? 1 : -1));
			return type(state, form, field.name, key) ?? { state, effect: NOTHING };
		}
		const move = Grid.moveBy(key);
		if (move !== undefined) return focus(state, form, form.field + move);
		const by = Grid.stepBy(key);
		return by === undefined
			? { state, effect: NOTHING }
			: change(state, form, by);
	};

	/**
	 * A click on the `index`th field: it takes the focus, and a click on the field already in hand
	 * moves its value on, as `l` does (the board's click-then-click, with no double-click timing). A
	 * typed field in hand stays as it is.
	 */
	export const click = (state: State, index: number): Step => {
		const form = state.dispatch?.form;
		if (!form) return { state, effect: NOTHING };
		if (index !== form.field) return focus(state, form, index);
		const field = inHand(form);
		return field === undefined || typed(field.input)
			? { state, effect: NOTHING }
			: change(state, form, 1);
	};
}
