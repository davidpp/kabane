import { expect, it } from "bun:test";
import { validateAnswer } from "./answer";
import { formatDecisionBody, parseDecisionBody } from "./body";
import { AskQuestionSchema } from "./schema";

it("round-trips module metadata without changing core's question body", () => {
	const parsed = parseDecisionBody(
		formatDecisionBody("Which?", {
			choices: ["A", "B"],
			recommended: "B",
			allowFreeform: false,
		}),
	);
	expect(parsed).toMatchObject({
		question: "Which?",
		choices: ["A", "B"],
		recommended: "B",
		allowFreeform: false,
	});
	expect(parseDecisionBody("Plain text")).toMatchObject({
		question: "Plain text",
		allowFreeform: true,
	});
});
it("validates canonical choices, comma lists and free text", () => {
	const meta = {
		choices: ["Alpha", "Beta"],
		multiSelect: false,
		allowFreeform: false,
	};
	expect(validateAnswer(meta, "  aLPHa ")).toEqual({
		ok: true,
		value: "Alpha",
	});
	expect(validateAnswer(meta, "Gamma").ok).toBe(false);
	expect(validateAnswer(meta, "Alpha, Beta").ok).toBe(false);
	expect(
		validateAnswer({ ...meta, multiSelect: true }, "beta, ALPHA, beta"),
	).toEqual({ ok: true, value: "Beta, Alpha" });
	expect(validateAnswer({ ...meta, multiSelect: true }, "Alpha,").ok).toBe(
		false,
	);
	expect(
		validateAnswer({ ...meta, allowFreeform: true }, "Other option"),
	).toEqual({ ok: true, value: "Other option" });
	expect(validateAnswer({ ...meta, allowFreeform: true }, " ").ok).toBe(false);
});
it("takes a choice's label for the choice and records its full text", () => {
	const meta = {
		choices: [
			"A. A worktree per claim",
			"B. One tree, serial by default",
			"Yes: one bounded pass",
			"c) Keep it",
		],
		multiSelect: false,
		allowFreeform: false,
	};
	for (const typed of ["B", "B.", "b", " b. "])
		expect(validateAnswer(meta, typed)).toEqual({
			ok: true,
			value: "B. One tree, serial by default",
		});
	expect(validateAnswer(meta, "yes")).toEqual({
		ok: true,
		value: "Yes: one bounded pass",
	});
	expect(validateAnswer(meta, "C)")).toEqual({ ok: true, value: "c) Keep it" });
	expect(validateAnswer(meta, "b. one tree, SERIAL by default")).toEqual({
		ok: true,
		value: "B. One tree, serial by default",
	});
	expect(validateAnswer(meta, "D").ok).toBe(false);
	// A label is the whole text before its separator, not any prefix or the rest.
	expect(validateAnswer(meta, "One tree").ok).toBe(false);
	expect(
		validateAnswer(
			{ choices: ["A. Yes", "B. No"], multiSelect: true, allowFreeform: false },
			"b, A., b",
		),
	).toEqual({ ok: true, value: "B. No, A. Yes" });
	// On a question that takes free text, a label still means its choice.
	expect(validateAnswer({ ...meta, allowFreeform: true }, "a")).toEqual({
		ok: true,
		value: "A. A worktree per claim",
	});
});
it("refuses a label two choices share and names them, while full text still answers", () => {
	const meta = {
		choices: ["A. Keep it", "A: Drop it", "B. Defer"],
		multiSelect: false,
		allowFreeform: true,
	};
	const ambiguous = validateAnswer(meta, "a");
	expect(ambiguous.ok).toBe(false);
	if (!ambiguous.ok)
		expect(ambiguous.error.message).toBe(
			'"a" labels more than one choice; answer with the full text of one: A. Keep it | A: Drop it.',
		);
	expect(validateAnswer(meta, "A: drop it")).toEqual({
		ok: true,
		value: "A: Drop it",
	});
	expect(validateAnswer(meta, "B")).toEqual({ ok: true, value: "B. Defer" });
});
it("takes a recommended choice by its label and stores its full text", () => {
	const parsed = AskQuestionSchema.safeParse({
		question: "Which?",
		choices: ["A. Keep", "B. Drop"],
		recommended: "b",
	});
	expect(parsed.success && parsed.data.recommended).toBe("B. Drop");
	expect(
		AskQuestionSchema.safeParse({
			question: "Which?",
			choices: ["A. Keep", "A) Drop"],
			recommended: "A",
		}).success,
	).toBe(false);
});
it("rejects unreachable recommendations and ambiguous or unanswerable choices", () => {
	for (const value of [
		{ recommended: "C", choices: ["A", "B"] },
		{ choices: ["A", "a"] },
		{ allowFreeform: false },
		{ choices: ["A, B"], multiSelect: true },
	])
		expect(
			AskQuestionSchema.safeParse({ question: "Which?", ...value }).success,
		).toBe(false);
});

it("defaults choices to strict answers but keeps explicit freeform and text-only questions", () => {
	for (const [input, freeform] of [
		[{ question: "Pick", choices: ["Alpha"] }, false],
		[{ question: "Pick", choices: ["Alpha"], allowFreeform: true }, true],
		[{ question: "Tell me" }, true],
	] as const) {
		const parsed = AskQuestionSchema.safeParse(input);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.allowFreeform).toBe(freeform);
	}
});
