// An agent's decision as the copilot's form, and the form's fields back to the one answer
// `Questions.answer` takes, judged as the MCP tool judges it.
import { describe, expect, it } from "bun:test";
import type { DecisionMeta } from "@cabane/questions";
import { DecisionForm } from "./decision-form";
import { Fixtures } from "./stories/fixtures";

const ON = Fixtures.task({ id: "t1", shortId: "JREP-7" });
const decision = (meta: DecisionMeta, why?: string) =>
	DecisionForm.of(Fixtures.decision(ON, 1, "Which store?", meta, { why }));

const fieldsOf = (meta: DecisionMeta) =>
	decision(meta).request.fields.map((f) => ({
		key: f.key,
		type: f.type,
		title: f.title,
		required: f.required,
	}));

const answer = (d: DecisionForm.Decision, content: Record<string, unknown>) =>
	DecisionForm.answerOf(
		d,
		content as Parameters<typeof DecisionForm.answerOf>[1],
	);

describe("a decision as a form", () => {
	it("asks a closed choice, the recommended one starred, with why under the question", () => {
		const d = decision(
			{
				choices: ["SQLite", "Redis"],
				recommended: "SQLite",
				allowFreeform: false,
			},
			"Local first",
		);
		expect(d.handle).toBe("JREP-7:1");
		expect(d.request.message).toBe("Which store?\nwhy: Local first");
		const [choice] = d.request.fields;
		expect(choice?.type === "choice" && choice.options).toEqual([
			{ value: "SQLite", label: "SQLite ★" },
			{ value: "Redis", label: "Redis" },
		]);
		expect(
			fieldsOf({ choices: ["SQLite", "Redis"], allowFreeform: false }),
		).toEqual([
			{ key: "choice", type: "choice", title: "Answer", required: true },
			{ key: "reasoning", type: "text", title: "Reasoning", required: false },
		]);
	});

	it("puts an Other box behind choices that take a typed answer, and leaves both optional", () => {
		expect(
			fieldsOf({
				choices: ["Lint", "Tests"],
				multiSelect: true,
				allowFreeform: true,
			}),
		).toEqual([
			{ key: "choice", type: "choices", title: "Answers", required: false },
			{ key: "other", type: "text", title: "Other", required: false },
			{ key: "reasoning", type: "text", title: "Reasoning", required: false },
		]);
	});

	it("asks a question with no choices as one required typed answer", () => {
		expect(fieldsOf({})).toEqual([
			{ key: "other", type: "text", title: "Answer", required: true },
			{ key: "reasoning", type: "text", title: "Reasoning", required: false },
		]);
	});
});

describe("the form's fields as the answer", () => {
	const single = decision({
		choices: ["SQLite", "Redis"],
		allowFreeform: true,
	});
	const multi = decision({
		choices: ["Lint", "Tests"],
		multiSelect: true,
		allowFreeform: true,
	});

	it("answers with the choice picked, and the reasoning when one was given", () => {
		expect(answer(single, { choice: "Redis" })).toEqual({
			ok: true,
			value: { answer: "Redis" },
		});
		expect(
			answer(single, { choice: "Redis", reasoning: "  shared  " }),
		).toEqual({ ok: true, value: { answer: "Redis", reasoning: "shared" } });
	});

	it("takes a typed Other over a single choice: typing one says none of them is it", () => {
		expect(answer(single, { choice: "Redis", other: "Postgres" })).toEqual({
			ok: true,
			value: { answer: "Postgres" },
		});
	});

	it("joins a multi-select's picks and its Other into the comma list validateAnswer reads", () => {
		expect(answer(multi, { choice: ["Tests", "Lint"], other: "Docs" })).toEqual(
			{ ok: true, value: { answer: "Tests, Lint, Docs" } },
		);
	});

	it("joins picks whose text holds commas into a list that reads back as those picks", () => {
		const commas = decision({
			choices: ["A. Keep it, for now", "B. Drop it", "C. Defer"],
			multiSelect: true,
			allowFreeform: false,
		});
		expect(
			answer(commas, { choice: ["A. Keep it, for now", "C. Defer"] }),
		).toEqual({ ok: true, value: { answer: "A. Keep it, for now, C. Defer" } });
	});

	it("refuses an answer with nothing picked and nothing typed, saying what it wants", () => {
		const empty = answer(multi, { reasoning: "no idea" });
		expect(empty.ok ? "" : empty.error.message).toBe(
			"pick an answer or type one",
		);
		const freeform = answer(decision({}), {});
		expect(freeform.ok ? "" : freeform.error.message).toBe("type an answer");
	});
});
