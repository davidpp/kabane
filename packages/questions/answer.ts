import { err, ok, type ParsedQuestion, type Result } from "@cabane/core";

/** Normalize choice labels once, for every answering surface. */
export const validateAnswer = (
	meta: Pick<ParsedQuestion, "choices" | "multiSelect" | "allowFreeform">,
	answer: string,
): Result<string> => {
	const text = answer.trim();
	if (!text) return err(new Error("An answer cannot be empty."));
	const parts = meta.multiSelect
		? text.split(",").map((part) => part.trim())
		: [text];
	const labels: string[] = [];
	for (const part of parts) {
		if (!part) return err(new Error("Each selection must be nonempty."));
		const choice = meta.choices.find(
			(label) => label.toLowerCase() === part.toLowerCase(),
		);
		if (choice === undefined && !meta.allowFreeform)
			return err(
				new Error(
					`Unknown choice "${part}"; choose ${meta.choices.join(", ")}.`,
				),
			);
		const label = choice ?? part;
		if (!labels.includes(label)) labels.push(label);
	}
	return ok(labels.join(", "));
};
