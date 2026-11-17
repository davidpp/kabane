import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, tryCatch, trySync } from "@cabane/core";
import { z } from "zod";
import { Inputs } from "./inputs";
import { Recipe } from "./recipe";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

// A project with the skills the recipes below name: research and go in Codex's folder, tidy in
// Claude Code's.
const ROOT = mkdtempSync(join(tmpdir(), "recipe-parse-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const skill = (folder: string, name: string) => {
	mkdirSync(join(ROOT, folder, name), { recursive: true });
	writeFileSync(
		join(ROOT, folder, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name}\n---\n`,
	);
};
skill(".agents/skills", "research");
skill(".agents/skills", "go");
skill(".claude/skills", "tidy");

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
`;

const parsed = (text: string, file = FILE) => Recipe.parse(z, ROOT, file, text);
const recipe = (): Recipe.Recipe => {
	const result = parsed(RESEARCH);
	if (!result.ok) throw result.error;
	return result.value;
};
const message = (result: { ok: boolean; error?: Error }) =>
	result.ok ? "ok" : result.error?.message;

describe("Recipe.parse", () => {
	it("reads the frontmatter, the skill named after the recipe and a hash of both files", () => {
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
			skill: "research",
			skillFile: ".agents/skills/research/SKILL.md",
		});
		expect(research.hash).toMatch(/^[0-9a-f]{12}$/);
	});

	it("takes the skill the frontmatter names, from Claude Code's folder when Codex's has none", () => {
		const named = parsed("---\nskill: tidy\n---\n");
		expect(named.ok && named.value).toMatchObject({
			name: "research",
			skill: "tidy",
			skillFile: ".claude/skills/tidy/SKILL.md",
		});
	});

	it("names both places it looked when the skill is in neither", () => {
		expect(message(parsed("---\nskill: absent\n---\n"))).toBe(
			`${FILE}: no skill "absent": kabane looked for .agents/skills/absent/SKILL.md and .claude/skills/absent/SKILL.md`,
		);
	});

	it("refuses a body, saying where the prompt goes", () => {
		expect(message(parsed("---\ntarget: issue\n---\nResearch it.\n"))).toBe(
			`${FILE}: a recipe has no body: the prompt belongs in the skill. Move it to .agents/skills/research/SKILL.md, with name: research and a description in its frontmatter; make .claude/skills/research a symlink to ../../.agents/skills/research so Claude Code finds it too; leave only the frontmatter here`,
		);
	});

	it("reads harness as a list, a single word as a list of one, and none as absent", () => {
		const front = (harness: string) =>
			parsed(`---\nharness: ${harness}\n---\n`, ".kabane/recipes/go.md");
		const listed = front("[sh, -c, 'echo hi']");
		expect(listed.ok && listed.value.harness).toEqual(["sh", "-c", "echo hi"]);
		const one = front("codex");
		expect(one.ok && one.value.harness).toEqual(["codex"]);
		expect(recipe().harness).toBeUndefined();
		expect(message(front("codex exec"))).toBe(
			".kabane/recipes/go.md: harness: a harness is one word, or a list with one word per item: [codex, exec]",
		);
		expect(message(front("[]"))).toContain(".kabane/recipes/go.md: harness");
	});

	it("takes an empty file as a recipe with no target and no inputs", () => {
		const plain = parsed("", ".kabane/recipes/tidy.md");
		expect(plain.ok && plain.value).toMatchObject({
			name: "tidy",
			target: "none",
			inputs: {},
			skill: "tidy",
		});
	});

	it.each([
		["---\ntarget: issue\n", "the frontmatter has no closing ---"],
		["---\ntarget: [\n---\n", "the frontmatter is not YAML"],
		["---\ntarget: repo\n---\n", "target: Invalid enum value"],
		["---\ntitle: x\n---\n", "Unrecognized key(s) in object: 'title'"],
		["---\ninputs:\n  n:\n    type: date\n---\n", "inputs.n.type"],
		[
			"---\ninputs:\n  n:\n    type: number\n    options: [a]\n---\n",
			'input "n": options need type string',
		],
		[
			"---\ninputs:\n  n:\n    type: number\n    default: x\n---\n",
			'input "n": its default "x" is not a number',
		],
		[
			"---\ninputs:\n  d:\n    options: [a, b]\n    default: c\n---\n",
			'its default "c" is not one of its options (a, b)',
		],
		["---\nskill: ../x\n---\n", "skill: a skill's name is lowercase letters"],
		["Research it.\n", "a recipe has no body"],
	])("refuses %j, naming the file", (text, why) => {
		const result = parsed(text);
		expect(result.ok).toBe(false);
		expect(message(result)).toStartWith(`${FILE}: `);
		expect(message(result)).toContain(why);
	});

	it("refuses a file name that is not a recipe name", () => {
		expect(message(parsed("", ".kabane/recipes/Big Name.md"))).toContain(
			"a recipe's file name is lowercase letters",
		);
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
			ROOT,
			".kabane/recipes/go.md",
			"---\ninputs:\n  depth:\n    options: [quick, thorough]\n    required: true\n    label: Depth\n---\n",
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
