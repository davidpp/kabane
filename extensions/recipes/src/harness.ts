// The harness a run starts: a command as a list of words, the prompt appended as its last. Where it
// comes from, most specific first: what the human set at launch (`kabane run --harness`, the board's
// form), a job's own, the recipe's frontmatter, the `recipes.harness` setting, then `claude`.
// Kabane adds no flags of its own to any of them.
//
// What a human reads and edits is the command line, quoted as a POSIX shell would take it, so a
// word with a space or a comma in it survives the round trip through the board's form.
import type { Result } from "@cabane/extension";
import { err, ok } from "./result";

export namespace Harness {
	type Source = "launch" | "job" | "recipe" | "setting" | "default";
	export type Chosen = { argv: readonly string[]; source: Source };

	const DEFAULT: readonly string[] = ["claude"];

	const ORDER = ["launch", "job", "recipe", "setting"] as const;

	/** The most specific harness given, and where it came from. */
	export const choose = (
		given: Partial<
			Record<(typeof ORDER)[number], readonly string[] | undefined>
		>,
	): Chosen => {
		for (const source of ORDER) {
			const argv = given[source];
			if (argv !== undefined) return { argv, source };
		}
		return { argv: DEFAULT, source: "default" };
	};

	const FROM: Readonly<Record<Source, string>> = {
		launch: "set at launch",
		job: "from the job",
		recipe: "from the recipe",
		setting: "from recipes.harness",
		default: "kabane's default",
	};

	/** Where a harness came from, as a human reads it: "from the recipe". */
	export const from = (source: Source): string => FROM[source];

	const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

	/** `argv` as a shell command line: a word with anything but plain characters in single quotes. */
	export const line = (argv: readonly string[]): string =>
		argv
			.map((word) =>
				PLAIN.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`,
			)
			.join(" ");

	/** "claude  (from the recipe)": the command line and where it came from. */
	export const describe = ({ argv, source }: Chosen): string =>
		`${line(argv)}  (${from(source)})`;

	/**
	 * The words of a command line, split as a POSIX shell splits them, with no expansion: blanks
	 * separate words, single quotes keep everything, double quotes keep all but `\` before `"`, `\`,
	 * `$` or a backtick, and a `\` outside quotes keeps the next character.
	 */
	export const split = (text: string): Result<string[]> => {
		const words: string[] = [];
		let word = "";
		let inWord = false;
		let quote: "'" | '"' | undefined;
		for (let at = 0; at < text.length; at++) {
			const char = text[at] ?? "";
			const next = text[at + 1];
			if (quote === "'") {
				if (char === "'") quote = undefined;
				else word += char;
			} else if (quote === '"') {
				if (char === '"') quote = undefined;
				else if (
					char === "\\" &&
					next !== undefined &&
					'"\\$`'.includes(next)
				) {
					word += next;
					at++;
				} else word += char;
			} else if (/\s/.test(char)) {
				if (inWord) words.push(word);
				word = "";
				inWord = false;
			} else {
				inWord = true;
				if (char === "'" || char === '"') quote = char;
				else if (char === "\\" && next !== undefined) {
					word += next;
					at++;
				} else word += char;
			}
		}
		if (quote !== undefined)
			return err(new Error(`the harness has an unclosed ${quote}: ${text}`));
		if (inWord) words.push(word);
		return words.length > 0
			? ok(words)
			: err(new Error("the harness is empty: give the command to start"));
	};
}
