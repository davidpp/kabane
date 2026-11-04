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

	it("an optional choice can be skipped with s, and the typed answer carries", () => {
		expect(run(STORE, [{ key: "s" }, { send: " Postgres " }])).toEqual({
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
				draft: {
					at: 0,
					values: {},
					picked: [0, 1],
					cursor: 2,
					error: "pick at most 2",
				},
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

		it("space toggles the cursor's option and enter sends, the cursor held at either end", () => {
			expect(
				run(tags, [
					{ key: "down" },
					{ key: "space" },
					{ key: "down" },
					{ key: "down" },
					{ key: "space" },
					{ key: "up" },
					{ key: "up" },
					{ key: "up" },
					{ key: "space" },
					{ key: "space" },
					{ key: "return" },
				]),
			).toEqual({
				answer: { action: "accept", content: { tags: ["b", "c"] } },
			});
		});

		it("a digit toggles its option and takes the cursor there, so space then toggles it back", () => {
			expect(run(tags, [{ key: "3" }])).toEqual({
				draft: { at: 0, values: {}, picked: [2], cursor: 2 },
			});
			expect(run(tags, [{ key: "3" }, { key: "space" }])).toMatchObject({
				draft: { picked: [], cursor: 2 },
			});
		});

		it("s skips an optional one, toggles and all, and is no key on a required one", () => {
			const optional = form({ ...TAGS, required: false });
			expect(run(optional, [{ key: "1" }, { key: "s" }])).toEqual({
				answer: { action: "accept", content: {} },
			});
			expect(run(tags, [{ key: "s" }])).toBeNull();
		});
	});

	describe("a choice's cursor", () => {
		it("starts on the first option, and enter picks the option it is on", () => {
			expect(ElicitationForm.cursorOf(ElicitationForm.start())).toBe(0);
			expect(run(STORE, [{ key: "return" }, { send: "" }])).toEqual({
				answer: { action: "accept", content: { question_0: "Redis" } },
			});
			expect(
				run(STORE, [{ key: "down" }, { key: "return" }, { send: "" }]),
			).toEqual({
				answer: { action: "accept", content: { question_0: "Memory" } },
			});
		});

		it("is held at either end, and each field starts it again on its first option", () => {
			expect(run(STORE, [{ key: "up" }])).toEqual({
				draft: { at: 0, values: {}, picked: [], cursor: 0 },
			});
			expect(run(STORE, [{ key: "down" }, { key: "down" }])).toMatchObject({
				draft: { cursor: 1 },
			});
			const twice = form(
				...STORE.fields.slice(0, 1),
				...STORE.fields.slice(0, 1),
			);
			expect(run(twice, [{ key: "down" }, { key: "return" }])).toEqual({
				draft: { at: 1, values: { question_0: "Memory" }, picked: [] },
			});
		});

		it("a digit still picks directly, wherever the cursor is; space and j/k are no keys here", () => {
			expect(run(STORE, [{ key: "down" }, { key: "1" }, { send: "" }])).toEqual(
				{
					answer: { action: "accept", content: { question_0: "Redis" } },
				},
			);
			for (const name of ["space", "j", "k"])
				expect(run(STORE, [{ key: name }])).toBeNull();
		});

		it("pick answers by index as a click does, past the ninth option too", () => {
			const many = form({
				key: "n",
				title: "N",
				required: true,
				type: "choice",
				options: Array.from({ length: 12 }, (_, i) => ({
					value: `v${i}`,
					label: `L${i}`,
				})),
			});
			expect(ElicitationForm.pick(many, ElicitationForm.start(), 10)).toEqual({
				answer: { action: "accept", content: { n: "v10" } },
			});
			expect(
				ElicitationForm.pick(many, ElicitationForm.start(), 12),
			).toBeNull();
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

	it("text keeps to its length and pattern; a pattern that does not compile is left to the harness", () => {
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
		expect(run(broken, [{ send: "cache" }])).toEqual({
			answer: { action: "accept", content: { slug: "cache" } },
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
