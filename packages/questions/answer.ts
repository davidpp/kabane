import { err, ok, type ParsedQuestion, type Result } from "@cabane/core";

/** A choice's label, the text before its first `.`, `:` or `)`: `B` of "B. One tree". */
const choiceLabel = (choice: string): string | undefined =>
	choice.match(/^([^.:)]*)[.:)]/)?.[1]?.trim() || undefined;

/**
 * The choice `typed` names: its full text ignoring case, else the one choice whose label it is,
 * typed as `B`, `B.` or `b`. Undefined when it names none; refused when it labels more than one.
 */
export const matchChoice = (
	choices: readonly string[],
	typed: string,
): Result<string | undefined> => {
	const text = typed.trim().toLowerCase();
	const full = choices.find((choice) => choice.toLowerCase() === text);
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
	const parts = meta.multiSelect
		? text.split(",").map((part) => part.trim())
		: [text];
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
