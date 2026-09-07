/**
 * question-body convention tests (S4b)
 */

import { describe, expect, test } from "bun:test";
import { formatQuestionBody, parseQuestionBody } from "./question-body";

describe("question-body convention", () => {
	test("round-trips choices + flags through the json block", () => {
		const body = formatQuestionBody("Which cache?", {
			choices: ["Redis", "In-memory"],
			multiSelect: false,
			allowFreeform: true,
		});
		expect(body.startsWith("```json")).toBe(true);

		const parsed = parseQuestionBody(body);
		expect(parsed.question).toBe("Which cache?");
		expect(parsed.choices).toEqual(["Redis", "In-memory"]);
		expect(parsed.multiSelect).toBe(false);
		expect(parsed.allowFreeform).toBe(true);
	});

	test("round-trips batch position + default answer", () => {
		const body = formatQuestionBody("Q?", {
			questionIndex: 1,
			totalQuestions: 3,
			defaultAnswer: "yes",
		});
		const parsed = parseQuestionBody(body);
		expect(parsed.question).toBe("Q?");
		expect(parsed.questionIndex).toBe(1);
		expect(parsed.totalQuestions).toBe(3);
		expect(parsed.defaultAnswer).toBe("yes");
	});

	test("omits the json block entirely when there is no metadata", () => {
		const body = formatQuestionBody("Just a question?");
		expect(body).toBe("Just a question?");
		const parsed = parseQuestionBody(body);
		expect(parsed.question).toBe("Just a question?");
		expect(parsed.choices).toEqual([]);
		expect(parsed.multiSelect).toBe(false);
		expect(parsed.allowFreeform).toBe(true);
	});

	test("tolerates a plain body with no fence (freeform defaults)", () => {
		const parsed = parseQuestionBody("What do you think?");
		expect(parsed.question).toBe("What do you think?");
		expect(parsed.choices).toEqual([]);
		expect(parsed.allowFreeform).toBe(true);
	});

	test("tolerates a malformed json fence (whole body is the question)", () => {
		const body = "```json\n{not valid}\n```\n\nHello?";
		const parsed = parseQuestionBody(body);
		expect(parsed.question).toBe(body);
		expect(parsed.choices).toEqual([]);
	});
});
