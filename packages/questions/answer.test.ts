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
