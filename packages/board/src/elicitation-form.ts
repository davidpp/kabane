// A harness's form (an `elicitation` update), filled in one field at a time on the board. Pure
// functions over the form and the human's draft, so every key and every refusal is tested without a
// renderer; nav.ts routes the keys here and the elicitation block draws the draft.
//
// A choice takes a digit, as a permission does. A multi-select toggles with digits and confirms
// with `enter`. A boolean takes `y`/`n`. Text and numbers are typed into the block's input and sent
// with `enter`, which also leaves an optional field of any kind empty. `esc` declines the whole form
// wherever it is. Nothing is ever filled in on the human's behalf: a field they leave empty is
// absent from the answer.
import { FormField } from "./form-field";
import type {
	CopilotElicitation,
	CopilotElicitationAnswer,
	CopilotFormField,
	CopilotFormValue,
} from "./ports";

export namespace ElicitationForm {
	export type Draft = {
		// The field in hand, by its place in the form.
		at: number;
		// What was answered so far, by field key. An optional field left empty has no entry.
		values: Readonly<Record<string, CopilotFormValue>>;
		// The options toggled on the multi-select in hand, by index, in the order they were picked.
		picked: readonly number[];
		// Why the last answer to the field in hand was refused; the field is asked again.
		error?: string;
	};

	type Key = {
		name: string;
		sequence?: string;
		ctrl?: boolean;
		meta?: boolean;
	};

	// What a key or a send did: moved the draft on, or finished the form. A key the form does not
	// answer is null, and routes as it would without one.
	export type Step =
		| { draft: Draft }
		| { answer: CopilotElicitationAnswer }
		| null;

	export const start = (): Draft => ({ at: 0, values: {}, picked: [] });

	/** The field in hand, or undefined for a form with no fields (it asks only for a yes). */
	export const field = (
		request: CopilotElicitation,
		draft: Draft,
	): CopilotFormField | undefined => request.fields[draft.at];

	/** Whether the field in hand is typed into the input rather than answered by keys. */
	export const typed = (field: CopilotFormField | undefined): boolean =>
		field?.type === "text" || field?.type === "number";

	const DECLINE: CopilotElicitationAnswer = { action: "decline" };

	// The next field, or the form's answer after the last one.
	const advance = (
		request: CopilotElicitation,
		draft: Draft,
		value: CopilotFormValue | undefined,
	): Step => {
		const current = field(request, draft);
		const values =
			current && value !== undefined
				? { ...draft.values, [current.key]: value }
				: draft.values;
		const at = draft.at + 1;
		return at >= request.fields.length
			? { answer: { action: "accept", content: values } }
			: { draft: { at, values, picked: [] } };
	};

	const refuse = (draft: Draft, error: string): Step => ({
		draft: { ...draft, error },
	});

	// The digit a key types, 1-9, or undefined.
	const digitOf = (key: Key): number | undefined =>
		/^[1-9]$/.test(key.name) ? Number(key.name) : undefined;

	const isChar = (key: Key, char: string): boolean =>
		key.name === char || key.sequence === char;

	/** `index` toggled in or out of `picked`, which keeps the order things were picked in. */
	export const toggle = (
		picked: readonly number[],
		index: number,
	): readonly number[] =>
		picked.includes(index)
			? picked.filter((p) => p !== index)
			: [...picked, index];

	/**
	 * A key on the form in hand. `esc` declines anywhere; a typed field answers nothing else here,
	 * because its input takes the keys and `enter` arrives through `submit`.
	 */
	export const reduceKey = (
		request: CopilotElicitation,
		draft: Draft,
		key: Key,
	): Step => {
		if (key.ctrl || key.meta) return null;
		if (key.name === "escape") return { answer: DECLINE };
		const current = field(request, draft);
		if (typed(current)) return null;
		if (key.name === "return" || key.name === "enter")
			return submit(request, draft, "");
		if (!current) return null;
		switch (current.type) {
			case "boolean":
				if (isChar(key, "y")) return advance(request, draft, true);
				if (isChar(key, "n")) return advance(request, draft, false);
				return null;
			case "choice": {
				const digit = digitOf(key);
				const option =
					digit === undefined ? undefined : current.options[digit - 1];
				return option ? advance(request, draft, option.value) : null;
			}
			case "choices": {
				const digit = digitOf(key);
				if (digit === undefined || digit > current.options.length) return null;
				const picked = toggle(draft.picked, digit - 1);
				if (current.maxItems !== undefined && picked.length > current.maxItems)
					return refuse(draft, `pick at most ${current.maxItems}`);
				return { draft: { at: draft.at, values: draft.values, picked } };
			}
			default:
				return null;
		}
	};

	// The multi-select's picks, as the option values the harness is answered with.
	const pickedValues = (
		current: Extract<CopilotFormField, { type: "choices" }>,
		picked: readonly number[],
	): readonly string[] =>
		picked.flatMap((index) => {
			const option = current.options[index];
			return option ? [option.value] : [];
		});

	/**
	 * `enter` on the field in hand, with what its input holds (empty for a field answered by keys):
	 * the typed value, the multi-select's picks, or nothing for an optional field. A required field
	 * left empty, or an answer the field does not take, is refused and asked again. On a form with no
	 * fields, `enter` is the yes it asks for.
	 */
	export const submit = (
		request: CopilotElicitation,
		draft: Draft,
		text: string,
	): Step => {
		const current = field(request, draft);
		if (!current) return { answer: { action: "accept", content: {} } };
		const given = text.trim();
		if (current.type === "choices") {
			const count = draft.picked.length;
			if (count === 0 && !current.required)
				return advance(request, draft, undefined);
			const least = current.minItems ?? (current.required ? 1 : 0);
			if (count < least) return refuse(draft, `pick at least ${least}`);
			return advance(request, draft, pickedValues(current, draft.picked));
		}
		if (given === "")
			return current.required
				? refuse(draft, `required: ${FormField.wants(current)}`)
				: advance(request, draft, undefined);
		if (current.type !== "number" && current.type !== "text")
			return refuse(draft, `"${given}" is not ${FormField.wants(current)}`);
		const value = FormField.read(current, given);
		return value.ok
			? advance(request, draft, value.value)
			: refuse(draft, `"${given}" ${value.error.message}`);
	};
}
