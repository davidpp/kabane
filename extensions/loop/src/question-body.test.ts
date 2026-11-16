import { describe, expect, it } from "bun:test";
import {
	answersContext,
	formatQuestionBody,
	isAnswerTo,
	parseQuestionBody,
} from "./question-body";

describe("loop question format", () => {
	it("round-trips harness options, form metadata and text", () => {
		const meta = {
			choices: ["Allow", "Reject"],
			multiSelect: false,
			allowFreeform: false,
			questionIndex: 0,
			totalQuestions: 2,
			skipAnswer: "skip",
			permission: {
				toolCallId: "call-1",
				title: "Write notes.md",
				options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
			},
		};
		expect(parseQuestionBody(formatQuestionBody("Proceed?", meta))).toEqual({
			...meta,
			question: "Proceed?",
		});
	});
	it("keeps plain text and malformed metadata as freeform questions", () => {
		for (const body of [
			"Which port?",
			"```json\n{broken}\n```\nQuestion",
			'```json\n{"choices":42}\n```\nQuestion',
		])
			expect(parseQuestionBody(body)).toEqual({
				question: body,
				choices: [],
				multiSelect: false,
				allowFreeform: true,
			});
		expect(formatQuestionBody("Which port?", { choices: undefined })).toBe(
			"Which port?",
		);
	});
	it("matches only exact answer provenance", () => {
		expect(isAnswerTo(answersContext("q1"), "q1")).toBe(true);
		expect(isAnswerTo(answersContext("q10"), "q1")).toBe(false);
		expect(isAnswerTo(undefined, "q1")).toBe(false);
	});
});
