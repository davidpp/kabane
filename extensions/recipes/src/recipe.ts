// A recipe is `<root>/.kabane/recipes/<name>.md`: YAML frontmatter that declares its target, its
// inputs and the harness it is written for, and its prompt, one of two kinds. A project skill, in
// `.agents/skills/<skill>/SKILL.md` or `.claude/skills/<skill>/SKILL.md`, which the harness loads
// itself: the frontmatter's `skill`, or with no body the skill named after the recipe. Or its own
// body, with `{{...}}` placeholders kabane fills in. A file that does not parse is an error naming
// it, never a recipe skipped in silence.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Host, Result, TriggerInput } from "@kabane/extension";
import { err, ok, trySync } from "./result";

export namespace Recipe {
	type InputType = "string" | "number" | "boolean";
	export type Value = string | number | boolean;
	export type Input = Omit<TriggerInput, "type" | "default" | "group"> & {
		type: InputType;
		default?: Value;
	};
	/** What a run works on: an issue, or the job that scheduled it. */
	export type Target = {
		kind: "issue" | "job";
		id: string;
		shortId: string;
		title: string;
	};

	/** What every recipe has, whichever kind its prompt is. */
	type Common = {
		name: string;
		/** The file, relative to the scope root. */
		file: string;
		description?: string;
		target: "issue" | "job" | "none";
		inputs: Record<string, Input>;
		/** The command this recipe starts, ahead of `recipes.harness`. */
		harness?: string[];
		/** sha256 of the recipe file's bytes, then its skill's when it uses one, first 12 hex characters. */
		hash: string;
	};
	/** A recipe that names a project skill. */
	export type Skilled = Common & {
		/** The project skill the run uses: the frontmatter's `skill`, or the recipe's name. */
		skill: string;
		/** The skill's SKILL.md, relative to the scope root. */
		skillFile: string;
	};
	/** A recipe whose body is its prompt. */
	export type Written = Common & { body: string };
	export type Recipe = Skilled | Written;

	export const DIR = ".kabane/recipes";
	const NAME = /^[a-z0-9][a-z0-9_-]*$/;
	const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
	const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
	const TARGET_FIELDS = ["id", "shortId", "title"] as const;
	/** Where a skill is looked for, in order: Codex reads the first, Claude Code the second. */
	const SKILL_DIRS = [".agents/skills", ".claude/skills"] as const;

	const dir = (root: string): string => join(root, DIR);
	const skillPaths = (skill: string): string[] =>
		SKILL_DIRS.map((folder) => `${folder}/${skill}/SKILL.md`);

	const schema = (z: Host["z"]) => {
		const value = z.union([z.string(), z.number(), z.boolean()]);
		const input = z
			.object({
				type: z.enum(["string", "number", "boolean"]).default("string"),
				required: z.boolean().default(false),
				default: value.optional(),
				options: z.array(z.string()).min(1).optional(),
				label: z.string().optional(),
				hint: z.string().optional(),
			})
			.strict();
		// One word as a string; a command with arguments is a list, so no word is split on a guess.
		const harness = z
			.union([z.string(), z.array(z.string().min(1)).min(1)])
			.transform((value, ctx) => {
				if (typeof value !== "string") return value;
				if (/^\S+$/.test(value)) return [value];
				ctx.addIssue({
					code: "custom",
					message:
						"a harness is one word, or a list with one word per item: [codex, exec]",
				});
				return z.NEVER;
			});
		return z
			.object({
				description: z.string().optional(),
				skill: z
					.string()
					.regex(
						NAME,
						"a skill's name is lowercase letters, digits, - and _, starting with a letter or digit",
					)
					.optional(),
				target: z.enum(["issue", "job", "none"]).default("none"),
				inputs: z.record(z.string(), input).default({}),
				harness: harness.optional(),
			})
			.strict();
	};

	/** The first thing wrong with an input's declaration, or undefined. */
	const inputProblem = (name: string, input: Input): string | undefined => {
		if (!INPUT_NAME.test(name))
			return `input "${name}": a name is letters, digits, "_" and "-", starting with a letter or "_"`;
		if (input.options !== undefined && input.type !== "string")
			return `input "${name}": options need type string`;
		if (input.default === undefined) return undefined;
		if (typeof input.default !== input.type)
			return `input "${name}": its default ${JSON.stringify(input.default)} is not a ${input.type}`;
		if (
			input.options !== undefined &&
			!input.options.includes(String(input.default))
		)
			return `input "${name}": its default "${String(input.default)}" is not one of its options (${input.options.join(", ")})`;
		return undefined;
	};

	/** A placeholder the body uses that this recipe cannot fill, or undefined. */
	const placeholderProblem = (
		body: string,
		inputs: Record<string, Input>,
		target: Recipe["target"],
	): string | undefined => {
		for (const [, key = ""] of body.matchAll(PLACEHOLDER)) {
			const [head, field, ...more] = key.split(".");
			if (head === "inputs" && field !== undefined && more.length === 0) {
				if (field in inputs) continue;
				return `{{${key}}} names no declared input`;
			}
			if (head === "target" && field !== undefined && more.length === 0) {
				if (!(TARGET_FIELDS as readonly string[]).includes(field))
					return `{{${key}}}: a target has ${TARGET_FIELDS.map((f) => `target.${f}`).join(", ")}`;
				if (target !== "none") continue;
				return `{{${key}}} needs "target: issue" or "target: job" in the frontmatter`;
			}
			return `{{${key}}} is no placeholder: use inputs.<name> or target.<${TARGET_FIELDS.join("|")}>`;
		}
		return undefined;
	};

	/** A recipe file's frontmatter, as YAML gives it, and its body, trimmed. */
	const split = (text: string): Result<{ front: unknown; body: string }> => {
		const lines = text.split("\n");
		if (lines[0]?.trimEnd() !== "---")
			return ok({ front: {}, body: text.trim() });
		const end = lines.slice(1).findIndex((line) => line.trimEnd() === "---");
		if (end === -1) return err(new Error("the frontmatter has no closing ---"));
		const yaml = trySync(() =>
			Bun.YAML.parse(lines.slice(1, end + 1).join("\n")),
		);
		if (!yaml.ok)
			return err(
				new Error(`the frontmatter is not YAML: ${yaml.error.message}`),
			);
		return ok({
			front: yaml.value ?? {},
			body: lines
				.slice(end + 2)
				.join("\n")
				.trim(),
		});
	};

	/**
	 * Parse one recipe file's text and, unless its body is its prompt, find its skill under `root`.
	 * `file` names it in every error.
	 */
	export const parse = (
		z: Host["z"],
		root: string,
		file: string,
		text: string,
	): Result<Recipe> => {
		const fail = (why: string) => err(new Error(`${file}: ${why}`));
		const name = basename(file, ".md");
		if (!NAME.test(name))
			return fail(
				"a recipe's file name is lowercase letters, digits, - and _, starting with a letter or digit",
			);
		const parts = split(text);
		if (!parts.ok) return fail(parts.error.message);
		const parsed = schema(z).safeParse(parts.value.front, {
			error: (issue) => {
				if (issue.code === "unrecognized_keys")
					return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`;
				if (issue.code === "invalid_value" && issue.path?.[0] === "target")
					return `Invalid enum value. Expected ${issue.values.map((value) => `'${String(value)}'`).join(" | ")}, received '${String(issue.input)}'`;
				return undefined;
			},
		});
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const where = issue?.path.join(".") || "the frontmatter";
			return fail(`${where}: ${issue?.message ?? "invalid"}`);
		}
		const { description, target, inputs, harness } = parsed.data;
		for (const [key, input] of Object.entries(inputs)) {
			const problem = inputProblem(key, input);
			if (problem !== undefined) return fail(problem);
		}
		const common = {
			name,
			file,
			...(description === undefined ? {} : { description }),
			target,
			inputs,
			...(harness === undefined ? {} : { harness }),
		};
		const { body } = parts.value;
		if (body.length > 0) {
			if (parsed.data.skill !== undefined)
				return fail(
					`a recipe has a skill or a body, not both: remove "skill: ${parsed.data.skill}" to make the body its prompt, or remove the body to use the skill`,
				);
			const placeholder = placeholderProblem(body, inputs, target);
			if (placeholder !== undefined) return fail(placeholder);
			return ok({
				...common,
				body,
				hash: createHash("sha256").update(text).digest("hex").slice(0, 12),
			});
		}
		const skill = parsed.data.skill ?? name;
		const [skillFile, other] = skillPaths(skill);
		const found = skillPaths(skill).find((path) =>
			existsSync(join(root, path)),
		);
		if (found === undefined)
			return fail(
				`no skill "${skill}": kabane looked for ${skillFile} and ${other}`,
			);
		const procedure = trySync(() => readFileSync(join(root, found)));
		if (!procedure.ok) return fail(`${found}: ${procedure.error.message}`);
		return ok({
			...common,
			skill,
			skillFile: found,
			hash: createHash("sha256")
				.update(text)
				.update(procedure.value)
				.digest("hex")
				.slice(0, 12),
		});
	};

	const read = (z: Host["z"], root: string, path: string): Result<Recipe> => {
		const file = relative(root, path);
		const text = trySync(() => readFileSync(path, "utf8"));
		return text.ok
			? parse(z, root, file, text.value)
			: err(new Error(`${file}: ${text.error.message}`));
	};

	/** The recipe called `name` in the project at `root`. */
	export const load = (
		z: Host["z"],
		root: string,
		name: string,
	): Result<Recipe> => {
		const path = join(dir(root), `${name}.md`);
		if (!NAME.test(name) || !existsSync(path))
			return err(
				new Error(
					`No recipe "${name}" in ${relative(root, dir(root))}/; \`kabane run\` lists the recipes there`,
				),
			);
		return read(z, root, path);
	};

	/** A recipe file that failed to read or parse: its path from the project root, and why. */
	export type Broken = { file: string; error: Error };

	/**
	 * Every recipe of the project at `root`, by name, and each file that failed to parse. A
	 * directory that cannot be listed is one broken entry under the directory's own path.
	 */
	export const all = (
		z: Host["z"],
		root: string,
	): { recipes: Recipe[]; errors: Broken[] } => {
		const files = trySync(() =>
			existsSync(dir(root))
				? readdirSync(dir(root))
						.filter((entry) => entry.endsWith(".md"))
						.sort()
				: [],
		);
		if (!files.ok) {
			const file = relative(root, dir(root));
			return {
				recipes: [],
				errors: [{ file, error: new Error(`${file}: ${files.error.message}`) }],
			};
		}
		const recipes: Recipe[] = [];
		const errors: Broken[] = [];
		for (const entry of files.value) {
			const path = join(dir(root), entry);
			const recipe = read(z, root, path);
			if (recipe.ok) recipes.push(recipe.value);
			else errors.push({ file: relative(root, path), error: recipe.error });
		}
		return { recipes, errors };
	};

	/** The body with its placeholders filled. `parse` has checked every one can be. */
	export const render = (
		recipe: Pick<Written, "body">,
		inputs: Readonly<Record<string, Value>>,
		target?: Target,
	): string =>
		recipe.body.replace(PLACEHOLDER, (whole, key: string) => {
			const [head, field = ""] = key.split(".");
			// An optional input left out with no default reads as nothing.
			if (head === "inputs")
				return field in inputs ? String(inputs[field]) : "";
			if (head === "target" && target !== undefined)
				return target[field as (typeof TARGET_FIELDS)[number]];
			return whole;
		});
}
