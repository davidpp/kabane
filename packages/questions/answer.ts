import { err, ok, type ParsedQuestion, type Result } from "@cabane/core";

/** A choice's label, the text before its first `.`, `:` or `)`: `B` of "B. One tree". */
export const choiceLabel = (choice: string): string | undefined =>
	choice.match(/^([^.:)]*)[.:)]/)?.[1]?.trim() || undefined;

/** A choice's text as an answer compares it: ignoring case and the spacing around its commas. */
const fullText = (text: string): string =>
	text
		.split(",")
		.map((part) => part.trim())
		.join(", ")
		.toLowerCase();

/**
 * A multi-select answer as its selections. A choice's full text may hold commas, so each one
 * takes the longest run of comma-separated parts that is a choice's full text, else one part.
 */
const selectionsOf = (choices: readonly string[], text: string): string[] => {
	const parts = text.split(",");
	const selections: string[] = [];
	for (let start = 0; start < parts.length;) {
		let end = parts.length;
		while (
			end > start + 1 &&
			!choices.some(
				(choice) =>
					fullText(choice) === fullText(parts.slice(start, end).join(",")),
			)
		)
			end--;
		selections.push(parts.slice(start, end).join(",").trim());
		start = end;
	}
	return selections;
};

/**
 * The choice `typed` names: its full text ignoring case, else the one choice whose label it is,
 * typed as `B`, `B.` or `b`. Undefined when it names none; refused when it labels more than one.
 */
export const matchChoice = (
	choices: readonly string[],
	typed: string,
): Result<string | undefined> => {
	const text = fullText(typed);
	const full = choices.find((choice) => fullText(choice) === text);
	if (full !== undefined) return ok(full);
	const label = text.replace(/[.:)]$/, "").trimEnd();
	const labelled = choices.filter(
		(choice) => choiceLabel(choice)?.toLowerCase() === label,
	);
	if (labelled.length > 1)
		return err(
			new Error(
				`"${typed.trim()}" labels more than one choice; answer with the full text of one: ${labelled.join(" | ")}.`,
			),
		);
	return ok(labelled[0]);
};

/**
 * Normalize an answer once, for every answering surface: each choice it names, by full text or by
 * label, becomes that choice's full text, so the record reads the same whichever form was typed.
 */
export const validateAnswer = (
	meta: Pick<ParsedQuestion, "choices" | "multiSelect" | "allowFreeform">,
	answer: string,
): Result<string> => {
	const text = answer.trim();
	if (!text) return err(new Error("An answer cannot be empty."));
	const parts = meta.multiSelect ? selectionsOf(meta.choices, text) : [text];
	const picked: string[] = [];
	for (const part of parts) {
		if (!part) return err(new Error("Each selection must be nonempty."));
		const choice = matchChoice(meta.choices, part);
		if (!choice.ok) return choice;
		if (choice.value === undefined && !meta.allowFreeform)
			return err(
				new Error(
					`Unknown choice "${part}"; choose ${meta.choices.join(", ")}.`,
				),
			);
		const pick = choice.value ?? part;
		if (!picked.includes(pick)) picked.push(pick);
	}
	return ok(picked.join(", "));
};
