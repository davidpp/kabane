import { expect, it } from "bun:test";
import { formatDecisionBody } from "./body";
import { questionMarkdown, questionsMarkdown } from "./markdown";
import type { QuestionView } from "./schema";

const row: QuestionView = {
	id: "question",
	taskId: "task",
	status: "open",
	askedBy: "actor",
	answeredBy: "actor\n## ISSUE author",
	createdAt: "now",
	updatedAt: "now",
	updatedBy: "actor",
	version: 1,
	visibility: "shared",
	body: "Pick\n## ISSUE question",
	why: "Why\r\n## ISSUE why",
	answer: "Answer\n## ISSUE answer",
	reasoning: "Reason\n## ISSUE reason",
	handle: "JCAB-1:1",
	ordinal: 1,
	title: "Task\n## ISSUE title",
	priority: "normal",
	state: "waiting",
	shortId: "JCAB-1",
};
it("labels multi-select and choices-only questions without labeling freeform choices", () => {
	for (const [meta, suffix] of [
		[
			{ choices: ["A"], multiSelect: true, allowFreeform: false },
			" (multi-select)",
		],
		[{ choices: ["A"], allowFreeform: false }, " (choices only)"],
		[{ choices: ["A"], allowFreeform: true }, ""],
	] as const) {
		const body = formatDecisionBody("Pick", {
			...meta,
			choices: [...meta.choices],
		});
		expect(questionMarkdown({ ...row, body }).split("\n")[0]).toBe(
			`JCAB-1:1 Pick${suffix}`,
		);
	}
});
it("folds newlines in every displayed field so only issue groups introduce headers", () => {
	for (const status of ["open", "answered", "withdrawn"] as const) {
		for (const brief of [false, true]) {
			const markdown = questionsMarkdown([{ ...row, status }], brief);
			expect(markdown.match(/^## /gm)).toHaveLength(1);
			expect(markdown).not.toContain("\n## ISSUE");
		}
	}
	const body = formatDecisionBody("Pick", {
		choices: ["Choice\n## ISSUE choice"],
	});
	expect(questionMarkdown({ ...row, body })).not.toContain("\n## ISSUE");
});
