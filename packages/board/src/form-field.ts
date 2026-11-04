// What a human typed for one field of a harness's form, read the one way both surfaces that answer
// a form read it: the board's form (elicitation-form.ts) and the loop's tracker questions
// (extensions/loop's elicitation.ts). One form is then judged alike wherever it is answered.
import { err, ok, type Result, trySync } from "@cabane/core";
import type { CopilotFormField } from "./ports";

export namespace FormField {
	/** A field answered by typing: text, or a number. */
	export type Typed = Extract<CopilotFormField, { type: "text" | "number" }>;

	// ` from 1 to 5`, ` of at least 1`, or nothing, with what is counted after the bound.
	const range = (low?: number, high?: number, unit = ""): string =>
		low !== undefined && high !== undefined
			? ` from ${low} to ${high}${unit}`
			: low !== undefined
				? ` of at least ${low}${unit}`
				: high !== undefined
					? ` of at most ${high}${unit}`
					: "";

	/** What `field` wants, said where it is asked and when an answer misses it. */
	export const wants = (field: CopilotFormField): string => {
		switch (field.type) {
			case "number":
				return `${field.integer ? "a whole number" : "a number"}${range(field.minimum, field.maximum)}`;
			case "text":
				return `text${range(field.minLength, field.maxLength, " characters")}`;
			case "boolean":
				return "y or n";
			case "choice":
				return `one of 1-${field.options.length}`;
			case "choices":
				return `any of 1-${field.options.length}${range(field.minItems, field.maxItems, " picked")}`;
		}
	};

	const refused = (why: string): Result<never> => err(new Error(why));

	const readNumber = (
		field: Extract<Typed, { type: "number" }>,
		given: string,
	): Result<number> => {
		const value = given === "" ? Number.NaN : Number(given);
		const fits =
			Number.isFinite(value) &&
			(!field.integer || Number.isInteger(value)) &&
			(field.minimum === undefined || value >= field.minimum) &&
			(field.maximum === undefined || value <= field.maximum);
		return fits ? ok(value) : refused(`is not ${wants(field)}`);
	};

	const readText = (
		field: Extract<Typed, { type: "text" }>,
		given: string,
	): Result<string> => {
		const { minLength, maxLength, pattern } = field;
		if (
			(minLength !== undefined && given.length < minLength) ||
			(maxLength !== undefined && given.length > maxLength)
		)
			return refused(`is not ${wants(field)}`);
		// The harness's patterns are JSON Schema's, which are ECMAScript regular expressions over
		// Unicode, hence `u`. One that does not compile is the harness's bug, not the human's: the
		// answer is accepted and the harness, which wrote the pattern, is left to check it.
		const compiled =
			pattern === undefined
				? undefined
				: trySync(() => new RegExp(pattern, "u"));
		if (compiled?.ok && !compiled.value.test(given))
			return refused(`does not match ${pattern}`);
		return ok(given);
	};

	/**
	 * The value `given`, trimmed, gives a typed field, or why it gives none: the error's message
	 * reads after the answer, as in `"9" is not a whole number from 1 to 8`. Whether the field may be
	 * left empty is the caller's to decide; an empty answer here is read like any other.
	 */
	export const read = (field: Typed, given: string): Result<string | number> =>
		field.type === "number"
			? readNumber(field, given.trim())
			: readText(field, given.trim());
}
