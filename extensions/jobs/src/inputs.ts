// A recipe's inputs, from `--input k=v` pairs, a JSON object, the declared defaults and, at a
// terminal, a prompt for each required input still missing. Every value is checked against its
// declared type and options; any problem is one message the caller prints as a usage error.
import type { Host, Result } from "@kabane/extension";
import type { Recipe } from "./recipe";
import { err, ok, trySync } from "./result";

export namespace Inputs {
	export type Given = {
		/** `k=v`, as typed after `--input`. */
		pairs: readonly string[];
		/** A JSON object, as typed. */
		json?: string;
	};

	/**
	 * Ask the human for one input: the question and the numbered options, if any. Returns what
	 * they typed, or null when there is nothing more to read. Absent outside a terminal.
	 */
	export type Ask = (question: string) => string | null;

	type Values = Record<string, Recipe.Value>;

	const TRUE = ["true", "yes", "y", "1"];
	const FALSE = ["false", "no", "n", "0"];

	/** A typed value from what a human typed. */
	const fromText = (input: Recipe.Input, text: string): unknown => {
		if (input.type === "number")
			return text.trim() === "" ? Number.NaN : Number(text);
		if (input.type === "boolean") {
			const word = text.trim().toLowerCase();
			if (TRUE.includes(word)) return true;
			if (FALSE.includes(word)) return false;
			return text;
		}
		return text;
	};

	const check = (
		z: Host["z"],
		name: string,
		input: Recipe.Input,
		value: unknown,
		// What the human typed, when the value was converted from it.
		typed?: string,
	): Result<Recipe.Value> => {
		const schema =
			input.options !== undefined
				? z.enum(input.options as [string, ...string[]])
				: input.type === "number"
					? z.number().finite()
					: input.type === "boolean"
						? z.boolean()
						: z.string();
		const parsed = schema.safeParse(value);
		if (parsed.success) return ok(parsed.data as Recipe.Value);
		const wanted =
			input.options !== undefined
				? `one of ${input.options.join(", ")}`
				: `a ${input.type}`;
		return err(
			new Error(
				`input "${name}" must be ${wanted}, not ${JSON.stringify(typed ?? value)}`,
			),
		);
	};

	const given = (
		recipe: Recipe.Recipe,
		{ pairs, json }: Given,
	): Result<Record<string, { value: unknown; text: boolean }>> => {
		const raw: Record<string, { value: unknown; text: boolean }> = {};
		if (json !== undefined) {
			const parsed = trySync(() => JSON.parse(json) as unknown);
			if (
				!parsed.ok ||
				typeof parsed.value !== "object" ||
				parsed.value === null ||
				Array.isArray(parsed.value)
			)
				return err(
					new Error(`the inputs JSON must be an object, as {"name": value}`),
				);
			for (const [key, value] of Object.entries(parsed.value))
				raw[key] = { value, text: false };
		}
		for (const pair of pairs) {
			const eq = pair.indexOf("=");
			if (eq <= 0)
				return err(new Error(`--input takes name=value, not "${pair}"`));
			raw[pair.slice(0, eq)] = { value: pair.slice(eq + 1), text: true };
		}
		const unknown = Object.keys(raw).filter((key) => !(key in recipe.inputs));
		if (unknown.length > 0)
			return err(
				new Error(
					`recipe "${recipe.name}" has no input ${unknown.map((key) => `"${key}"`).join(", ")}; it takes ${Object.keys(recipe.inputs).join(", ") || "none"}`,
				),
			);
		return ok(raw);
	};

	const question = (name: string, input: Recipe.Input): string => {
		const head = `${input.label ?? name}${input.hint ? ` (${input.hint})` : ""}`;
		if (input.options === undefined) return `${head}: `;
		const list = input.options.map((option, at) => `  ${at + 1}. ${option}`);
		return `${head}\n${list.join("\n")}\nNumber or value: `;
	};

	/** Keep asking until the answer is valid; null when the human's input ended. */
	const prompt = (
		z: Host["z"],
		name: string,
		input: Recipe.Input,
		ask: Ask,
	): Result<Recipe.Value> => {
		let note = "";
		for (;;) {
			const answer = ask(`${note}${question(name, input)}`);
			if (answer === null)
				return err(new Error(`input "${name}" is required and was not given`));
			const text = answer.trim();
			if (text === "") continue;
			const picked =
				input.options !== undefined && /^\d+$/.test(text)
					? (input.options[Number(text) - 1] ?? text)
					: text;
			const value = check(z, name, input, fromText(input, picked), picked);
			if (value.ok) return value;
			note = `${value.error.message}\n`;
		}
	};

	/** The recipe's input values: given, else defaulted, else asked for when `ask` is present. */
	export const resolve = (
		z: Host["z"],
		recipe: Recipe.Recipe,
		from: Given,
		ask?: Ask,
	): Result<Values> => {
		const raw = given(recipe, from);
		if (!raw.ok) return raw;
		const values: Values = {};
		for (const [name, input] of Object.entries(recipe.inputs)) {
			const entry = raw.value[name];
			if (entry !== undefined) {
				const value = entry.text
					? check(
							z,
							name,
							input,
							fromText(input, String(entry.value)),
							String(entry.value),
						)
					: check(z, name, input, entry.value);
				if (!value.ok) return value;
				values[name] = value.value;
			} else if (input.default !== undefined) values[name] = input.default;
		}
		const missing = Object.entries(recipe.inputs).filter(
			([name, input]) => input.required && !(name in values),
		);
		if (missing.length === 0) return ok(values);
		if (ask === undefined)
			return err(
				new Error(
					`recipe "${recipe.name}" needs ${missing.map(([name]) => name).join(", ")}: pass ${missing.map(([name]) => `--input ${name}=<value>`).join(" ")} or add ${missing.length === 1 ? "it" : "them"} to the inputs JSON`,
				),
			);
		for (const [name, input] of missing) {
			const value = prompt(z, name, input, ask);
			if (!value.ok) return value;
			values[name] = value.value;
		}
		return ok(values);
	};
}
