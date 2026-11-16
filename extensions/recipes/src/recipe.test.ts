import { describe, expect, it } from "bun:test";
import { err, ok, tryCatch, trySync } from "@cabane/core";
import { z } from "zod";
import { Inputs } from "./inputs";
import { Recipe } from "./recipe";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const FILE = ".kabane/recipes/research.md";
const RESEARCH = `---
description: Research an issue
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
  limit:
    type: number
    required: true
  verbose:
    type: boolean
---

Research {{target.shortId}} ({{target.title}}) at {{ inputs.depth }} depth, {{inputs.limit}} sources, verbose {{inputs.verbose}}.
`;

const parsed = (text: string, file = FILE) => Recipe.parse(z, file, text);
const recipe = (): Recipe.Recipe => {
	const result = parsed(RESEARCH);
	if (!result.ok) throw result.error;
	return result.value;
};
const message = (result: { ok: boolean; error?: Error }) =>
	result.ok ? "ok" : result.error?.message;

describe("Recipe.parse", () => {
	it("reads the frontmatter, the body and a hash of the file", () => {
		const research = recipe();
		expect(research).toMatchObject({
			name: "research",
			file: FILE,
			description: "Research an issue",
			target: "issue",
			inputs: {
				depth: { type: "string", required: false, default: "medium" },
				limit: { type: "number", required: true },
				verbose: { type: "boolean", required: false },
			},
		});
		expect(research.body.startsWith("Research {{target.shortId}}")).toBe(true);
		expect(research.hash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("takes a file with no frontmatter as a prompt with no target and no inputs", () => {
		const plain = parsed("Tidy the README.\n", ".kabane/recipes/tidy.md");
		expect(plain.ok && plain.value).toMatchObject({
			name: "tidy",
			target: "none",
			inputs: {},
			body: "Tidy the README.",
		});
	});

	it.each([
		["---\ntarget: issue\nBody\n", "the frontmatter has no closing ---"],
		["---\ntarget: [\n---\nBody\n", "the frontmatter is not YAML"],
		["---\ntarget: repo\n---\nBody\n", "target: Invalid enum value"],
		["---\ntitle: x\n---\nBody\n", "Unrecognized key(s) in object: 'title'"],
		["---\ninputs:\n  n:\n    type: date\n---\nBody\n", "inputs.n.type"],
		[
			"---\ninputs:\n  n:\n    type: number\n    options: [a]\n---\nB\n",
			'input "n": options need type string',
		],
		[
			"---\ninputs:\n  n:\n    type: number\n    default: x\n---\nB\n",
			'input "n": its default "x" is not a number',
		],
		[
			"---\ninputs:\n  d:\n    options: [a, b]\n    default: c\n---\nB\n",
			'its default "c" is not one of its options (a, b)',
		],
		["---\ndescription: x\n---\n\n", "the body is empty"],
		["Use {{inputs.nope}}\n", "{{inputs.nope}} names no declared input"],
		["Fix {{target.id}}\n", '{{target.id}} needs "target: issue"'],
		[
			"---\ntarget: issue\n---\nFix {{target.url}}\n",
			"{{target.url}}: a target has target.id, target.shortId, target.title",
		],
		["Hi {{name}}\n", "{{name}} is no placeholder"],
	])("refuses %j, naming the file", (text, why) => {
		const result = parsed(text);
		expect(result.ok).toBe(false);
		expect(message(result)).toStartWith(`${FILE}: `);
		expect(message(result)).toContain(why);
	});

	it("refuses a file name that is not a recipe name", () => {
		expect(message(parsed("Body\n", ".kabane/recipes/Big Name.md"))).toContain(
			"a recipe's file name is lowercase letters",
		);
	});
});

describe("Recipe.render", () => {
	it("fills inputs and the target, and leaves an optional input with no value empty", () => {
		expect(
			Recipe.render(
				recipe(),
				{ depth: "quick", limit: 3 },
				{
					id: "01ABC",
					shortId: "JCAB-7",
					title: "A title",
				},
			),
		).toBe("Research JCAB-7 (A title) at quick depth, 3 sources, verbose .");
	});
});

describe("Inputs.resolve", () => {
	const resolve = (given: Inputs.Given, ask?: Inputs.Ask) =>
		Inputs.resolve(z, recipe(), given, ask);

	it("applies defaults and converts --input text to the declared type", () => {
		const values = resolve({ pairs: ["limit=4", "verbose=yes"] });
		expect(values.ok && values.value).toEqual({
			depth: "medium",
			limit: 4,
			verbose: true,
		});
	});

	it("takes a JSON object, with --input winning over it", () => {
		const values = resolve({
			pairs: ["depth=thorough"],
			json: '{"depth": "quick", "limit": 2}',
		});
		expect(values.ok && values.value).toEqual({ depth: "thorough", limit: 2 });
	});

	it.each([
		[
			{ pairs: [] },
			'recipe "research" needs limit: pass --input limit=<value> or add it to the inputs JSON',
		],
		[
			{ pairs: ["limit=4", "depth=deep"] },
			'input "depth" must be one of quick, medium, thorough, not "deep"',
		],
		[{ pairs: ["limit=many"] }, 'input "limit" must be a number, not "many"'],
		[
			{ pairs: ["limit=1", "verbose=maybe"] },
			'input "verbose" must be a boolean, not "maybe"',
		],
		[
			{ pairs: [], json: '{"limit": "2"}' },
			'input "limit" must be a number, not "2"',
		],
		[
			{ pairs: ["limit=1", "colour=red"] },
			'recipe "research" has no input "colour"; it takes depth, limit, verbose',
		],
		[{ pairs: ["limit"] }, '--input takes name=value, not "limit"'],
		[
			{ pairs: [], json: "[1]" },
			'the inputs JSON must be an object, as {"name": value}',
		],
	])("refuses %j", (given, why) => {
		expect(message(resolve(given))).toBe(why);
	});

	it("asks for a missing required input at a terminal, again after a bad answer", () => {
		const asked: string[] = [];
		const answers = ["", "lots", "5"];
		const values = resolve({ pairs: [] }, (question) => {
			asked.push(question);
			return answers.shift() ?? null;
		});
		expect(values.ok && values.value).toEqual({ depth: "medium", limit: 5 });
		expect(asked).toEqual([
			"limit: ",
			"limit: ",
			'input "limit" must be a number, not "lots"\nlimit: ',
		]);
	});

	it("shows options as a numbered list and takes the number", () => {
		const choice = Recipe.parse(
			z,
			".kabane/recipes/pick.md",
			"---\ninputs:\n  depth:\n    options: [quick, thorough]\n    required: true\n    label: Depth\n---\nGo {{inputs.depth}}\n",
		);
		if (!choice.ok) throw choice.error;
		const asked: string[] = [];
		const values = Inputs.resolve(
			z,
			choice.value,
			{ pairs: [] },
			(question) => {
				asked.push(question);
				return "2";
			},
		);
		expect(values.ok && values.value).toEqual({ depth: "thorough" });
		expect(asked).toEqual([
			"Depth\n  1. quick\n  2. thorough\nNumber or value: ",
		]);
	});

	it("stops when the human's input ends", () => {
		expect(message(resolve({ pairs: [] }, () => null))).toBe(
			'input "limit" is required and was not given',
		);
	});
});
