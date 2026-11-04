// A harness's form (an `elicitation` update), filled in one field at a time on the board. Pure
// functions over the form and the human's draft, so every key and every refusal is tested without a
// renderer; nav.ts routes the keys here and the elicitation block draws the draft.
//
// A choice or a multi-select has a cursor over its options, starting on the first, moved with
// `up`/`down`: `enter` picks the cursor's option on a choice, `space` toggles it on a multi-select,
// whose `enter` sends what is toggled. A digit names an option directly, as on a permission, and
// moves the cursor to it. `s` leaves an optional one empty. Not `j`/`k`: the form takes its keys
// ahead of every view, and those two go on moving the board and scrolling the transcript under it.
// A boolean takes `y`/`n`, `enter` leaving an optional one empty. Text and numbers are typed into the
// block's input and sent with `enter`, which also leaves an optional one empty. `esc` declines the
// whole form wherever it is. Nothing is ever filled in on the human's behalf: a field they leave
// empty is absent from the answer.
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
		// The option the cursor is on, on the choice or multi-select in hand, by index. Absent reads as
		// the first, where every field starts.
		cursor?: number;
		// Why the last answer to the field in hand was refused; the field is asked again.
		error?: string;
	};

	type Key = {
		name: string;
		sequence?: string;
		ctrl?: boolean;
		meta?: boolean;
		shift?: boolean;
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

	/** The option the cursor is on. */
	export const cursorOf = (draft: Draft): number => draft.cursor ?? 0;

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

	type Options = Extract<CopilotFormField, { type: "choice" | "choices" }>;

	/**
	 * Option `index` of the choice or multi-select in hand, as its digit or a click names it: a choice
	 * is answered with it, a multi-select toggles it, and the cursor moves to it. Null for a field
	 * with no options, or an index past them.
	 */
	export const pick = (
		request: CopilotElicitation,
		draft: Draft,
		index: number,
	): Step => {
		const current = field(request, draft);
		if (current?.type !== "choice" && current?.type !== "choices") return null;
		const option = current.options[index];
		if (!option) return null;
		if (current.type === "choice") return advance(request, draft, option.value);
		const picked = toggle(draft.picked, index);
		if (current.maxItems !== undefined && picked.length > current.maxItems)
			return refuse(
				{ ...draft, cursor: index },
				`pick at most ${current.maxItems}`,
			);
		return {
			draft: { at: draft.at, values: draft.values, picked, cursor: index },
		};
	};

	// The cursor `delta` options on, held at either end rather than wrapping.
	const move = (current: Options, draft: Draft, delta: 1 | -1): Step => ({
		draft: {
			...draft,
			cursor: Math.max(
				0,
				Math.min(cursorOf(draft) + delta, current.options.length - 1),
			),
		},
	});

	const isEnter = (key: Key): boolean =>
		key.name === "return" || key.name === "enter";

	// The keys of a field answered from its options.
	const reduceOptionKey = (
		request: CopilotElicitation,
		draft: Draft,
		current: Options,
		key: Key,
	): Step => {
		const digit = digitOf(key);
		if (digit !== undefined) return pick(request, draft, digit - 1);
		if (key.name === "up") return move(current, draft, -1);
		if (key.name === "down") return move(current, draft, 1);
		if (isChar(key, "s") && !key.shift)
			return current.required ? null : advance(request, draft, undefined);
		if (current.type === "choice")
			return isEnter(key) ? pick(request, draft, cursorOf(draft)) : null;
		if (key.name === "space" || isChar(key, " "))
			return pick(request, draft, cursorOf(draft));
		return isEnter(key) ? submit(request, draft, "") : null;
	};

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
		if (current?.type === "choice" || current?.type === "choices")
			return reduceOptionKey(request, draft, current, key);
		if (isEnter(key)) return submit(request, draft, "");
		if (current?.type !== "boolean") return null;
		if (isChar(key, "y")) return advance(request, draft, true);
		if (isChar(key, "n")) return advance(request, draft, false);
		return null;
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
