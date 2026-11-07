import { err, ok, type ParsedQuestion, type Result } from "@cabane/core";

/**
 * A choice's label, the text before its first `.`, `:` or `)` when whitespace follows it: `B` of
 * "B. One tree", `Yes` of "Yes: one pass". Punctuation inside the text is not a separator, so
 * "3.5 seconds" and "v1.2, then v2" have no label.
 */
export const choiceLabel = (choice: string): string | undefined =>
	choice.match(/^([^.:)]*)[.:)]\s/)?.[1]?.trim() || undefined;

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
 * Choices as an error lists them, each quoted: a choice's text may hold any separator, a comma
 * included, and JSON quoting escapes the one quote that could end it.
 */
const listed = (choices: readonly string[]): string =>
	choices.map((choice) => JSON.stringify(choice)).join(", ");

/** The one choice of `named`, undefined for none, refused with them all when there are several. */
const onlyChoice = (
	typed: string,
	named: readonly string[],
	how: string,
): Result<string | undefined> =>
	named.length > 1
		? err(
				new Error(
					`${JSON.stringify(typed.trim())} ${how} more than one choice; answer with the exact text of one: ${listed(named)}.`,
				),
			)
		: ok(named[0]);

/**
 * The choice `typed` names: its exact text ignoring case, else its text ignoring the spacing
 * around commas, else the choice whose label it is, typed as `B`, `B.` or `b`. Undefined when it
 * names none; refused when the spacing or the label leaves more than one.
 */
export const matchChoice = (
	choices: readonly string[],
	typed: string,
): Result<string | undefined> => {
	const exact = typed.trim().toLowerCase();
	const full = choices.find((choice) => choice.toLowerCase() === exact);
	if (full !== undefined) return ok(full);
	const text = fullText(typed);
	const spaced = onlyChoice(
		typed,
		choices.filter((choice) => fullText(choice) === text),
		"matches, comma spacing aside,",
	);
	if (!spaced.ok || spaced.value !== undefined) return spaced;
	const label = text.replace(/[.:)]$/, "").trimEnd();
	return onlyChoice(
		typed,
		choices.filter((choice) => choiceLabel(choice)?.toLowerCase() === label),
		"labels",
	);
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
					`Unknown choice ${JSON.stringify(part)}; choose ${listed(meta.choices)}.`,
				),
			);
		const pick = choice.value ?? part;
		if (!picked.includes(pick)) picked.push(pick);
	}
	return ok(picked.join(", "));
};
