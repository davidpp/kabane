import { describe, expect, it } from "bun:test";
import { ElicitationForm } from "./elicitation-form";
import type { CopilotElicitation, CopilotFormField } from "./ports";

const form = (...fields: CopilotFormField[]): CopilotElicitation => ({
	id: "form-1",
	message: "Which store should the cache use?",
	fields,
});

// What claude-agent-acp sends for one AskUserQuestion question: the choice, then its optional
// "Other" box.
const STORE = form(
	{
		key: "question_0",
		title: "Store",
		required: false,
		type: "choice",
		options: [
			{ value: "Redis", label: "Redis" },
			{ value: "Memory", label: "Memory" },
		],
	},
	{ key: "question_0_custom", title: "Other", required: false, type: "text" },
);

const key = (name: string) => ({ name });

// Every step a form can take, run in order from a fresh draft.
const run = (
	request: CopilotElicitation,
	steps: ({ key: string } | { send: string })[],
): ElicitationForm.Step => {
	let draft = ElicitationForm.start();
	let last: ElicitationForm.Step = { draft };
	for (const step of steps) {
		last =
			"key" in step
				? ElicitationForm.reduceKey(request, draft, key(step.key))
				: ElicitationForm.submit(request, draft, step.send);
		if (last && "draft" in last) draft = last.draft;
	}
	return last;
};

describe("ElicitationForm", () => {
	it("a digit picks a choice and moves on; an optional text left empty is absent from the answer", () => {
		expect(run(STORE, [{ key: "2" }, { send: "" }])).toEqual({
			answer: { action: "accept", content: { question_0: "Memory" } },
		});
	});

	it("an optional choice can be skipped with enter, and the typed answer carries", () => {
		expect(run(STORE, [{ key: "return" }, { send: " Postgres " }])).toEqual({
			answer: { action: "accept", content: { question_0_custom: "Postgres" } },
		});
	});

	it("esc declines from any field, and a digit past the options answers nothing", () => {
		expect(run(STORE, [{ key: "escape" }])).toEqual({
			answer: { action: "decline" },
		});
		expect(run(STORE, [{ key: "1" }, { key: "escape" }])).toEqual({
			answer: { action: "decline" },
		});
		expect(run(STORE, [{ key: "3" }])).toBeNull();
	});

	it("a typed field leaves every key to its input but esc", () => {
		const text = ElicitationForm.start();
		const onOther = { ...text, at: 1 };
		expect(ElicitationForm.reduceKey(STORE, onOther, key("1"))).toBeNull();
		expect(ElicitationForm.reduceKey(STORE, onOther, key("return"))).toBeNull();
		expect(ElicitationForm.typed(ElicitationForm.field(STORE, onOther))).toBe(
			true,
		);
	});

	describe("a multi-select", () => {
		const TAGS: CopilotFormField = {
			key: "tags",
			title: "Tags",
			required: true,
			type: "choices",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
				{ value: "c", label: "Gamma" },
			],
			maxItems: 2,
		};
		const tags = form(TAGS);

		it("toggles with digits and confirms with enter, in the order picked", () => {
			expect(
				run(tags, [
					{ key: "3" },
					{ key: "1" },
					{ key: "2" },
					{ key: "2" },
					{ key: "return" },
				]),
			).toEqual({
				answer: { action: "accept", content: { tags: ["c", "a"] } },
			});
		});

		it("refuses more than it allows, and a required one confirmed empty", () => {
			const over = run(tags, [{ key: "1" }, { key: "2" }, { key: "3" }]);
			expect(over).toEqual({
				draft: { at: 0, values: {}, picked: [0, 1], error: "pick at most 2" },
			});
			expect(run(tags, [{ key: "return" }])).toMatchObject({
				draft: { error: "pick at least 1" },
			});
		});

		it("an optional one confirmed empty is left out", () => {
			const optional = form({ ...TAGS, required: false });
			expect(run(optional, [{ key: "return" }])).toEqual({
				answer: { action: "accept", content: {} },
			});
		});
	});

	it("a boolean takes y and n, and nothing else", () => {
		const yes = form({
			key: "ok",
			title: "Proceed",
			required: true,
			type: "boolean",
		});
		expect(run(yes, [{ key: "y" }])).toEqual({
			answer: { action: "accept", content: { ok: true } },
		});
		expect(run(yes, [{ key: "n" }])).toEqual({
			answer: { action: "accept", content: { ok: false } },
		});
		expect(run(yes, [{ key: "1" }])).toBeNull();
		expect(run(yes, [{ key: "return" }])).toMatchObject({
			draft: { error: "required: y or n" },
		});
	});

	it("a number is read as one, inside its bounds, and asked again with why when it is not", () => {
		const count = form({
			key: "n",
			title: "Workers",
			required: true,
			type: "number",
			integer: true,
			minimum: 1,
			maximum: 8,
		});
		expect(run(count, [{ send: "4" }])).toEqual({
			answer: { action: "accept", content: { n: 4 } },
		});
		for (const given of ["four", "2.5", "0", "9"])
			expect(run(count, [{ send: given }])).toMatchObject({
				draft: {
					at: 0,
					error: `"${given}" is not a whole number from 1 to 8`,
				},
			});
		expect(run(count, [{ send: "" }])).toMatchObject({
			draft: { error: "required: a whole number from 1 to 8" },
		});
	});

	it("text keeps to its length and pattern; a pattern JavaScript cannot read accepts nothing", () => {
		const SLUG: CopilotFormField = {
			key: "slug",
			title: "Slug",
			required: true,
			type: "text",
			maxLength: 5,
			pattern: "^[a-z]+$",
		};
		const slug = form(SLUG);
		expect(run(slug, [{ send: "cache" }])).toEqual({
			answer: { action: "accept", content: { slug: "cache" } },
		});
		expect(run(slug, [{ send: "caches" }])).toMatchObject({
			draft: { error: '"caches" is not text of at most 5 characters' },
		});
		expect(run(slug, [{ send: "Cache" }])).toMatchObject({
			draft: { error: expect.stringContaining('"Cache"') },
		});
		const broken = form({ ...SLUG, pattern: "(" });
		expect(run(broken, [{ send: "cache" }])).toMatchObject({
			draft: { error: expect.any(String) },
		});
	});

	it("a refused answer clears once the field is answered", () => {
		const count = form(
			{ key: "n", title: "N", required: true, type: "number", integer: false },
			{ key: "m", title: "M", required: true, type: "number", integer: false },
		);
		expect(run(count, [{ send: "x" }, { send: "1.5" }])).toEqual({
			draft: { at: 1, values: { n: 1.5 }, picked: [] },
		});
	});

	it("a form with no fields asks only for a yes: enter accepts it with nothing in it", () => {
		expect(run(form(), [{ key: "return" }])).toEqual({
			answer: { action: "accept", content: {} },
		});
	});
});
