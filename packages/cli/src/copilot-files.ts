/**
 * What an enabled directory extension adds to the board's copilot, read from markdown files in its
 * directory rather than from its code: `copilot/procedures/<name>.md` (frontmatter `title`) is
 * appended to the copilot's instructions, and `copilot/shortcuts/<name>.md` (frontmatter `hint`,
 * a one-line body) is offered as `/<name>`. `{{extension}}` in a body or a procedure's title
 * becomes the extension's directory and nothing else is substituted. A file that cannot be used is refused on its own,
 * with one line naming the extension and the file, and the rest loads.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CopilotInstructions } from "@cabane/board/copilot-instructions";
import { err, ok, type Result, trySync } from "@cabane/core";
import type { CopilotShortcut } from "@cabane/extension";
import { z } from "zod";
import { Extensions } from "./extensions";

// Strict, so a file has no field for a harness mode, an allow list or an MCP entry: a procedure
// cannot carry a permission policy in its type.
const ProcedureFields = z
	.object({
		title: z
			.string()
			.trim()
			.min(1)
			.refine((title) => !title.includes("\n"), "must be one line"),
	})
	.strict();
const ShortcutFields = z.object({ hint: z.string().trim().min(1) }).strict();

const PROCEDURES = join("copilot", "procedures");
const SHORTCUTS = join("copilot", "shortcuts");
const PLACEHOLDER = "{{extension}}";
/** Far above any procedure kabane or the loop ships (the longest is under 5 KiB). */
const MAX_BYTES = 16 * 1024;
/** One sentence's worth; a longer description is dropped whole, never cut mid-word. */
const MAX_DESCRIPTION = 200;

// A function, not a string: a replacement string reads `$&` or `$$` in the path as a pattern.
const fill = (text: string, dir: string): string =>
	text.replaceAll(PLACEHOLDER, () => dir);

export namespace CopilotFiles {
	/** A refused file, or copilot directory, by its path under the extension's directory. */
	export type Refusal = Extensions.Refusal & { file: string };

	type Read = {
		procedures: CopilotInstructions.Contribution[];
		shortcuts: CopilotShortcut[];
		refused: Refusal[];
	};

	// The markdown files of one of an extension's copilot directories, by name, so the copilot
	// reads them in the same order on every device. An absent directory contributes nothing, and
	// so does every file not named *.md.
	const markdown = (dir: string, sub: string): Result<string[]> => {
		const stat = trySync(() => statSync(join(dir, sub)));
		if (!stat.ok) return ok([]);
		if (!stat.value.isDirectory())
			return err(new Error(`${sub} must be a directory; it is a file`));
		const entries = trySync(() => readdirSync(join(dir, sub)));
		if (!entries.ok)
			return err(new Error(`${sub} cannot be listed; make it readable`));
		return ok(
			entries.value
				.filter((entry) => entry.endsWith(".md"))
				.sort()
				.map((entry) => join(sub, entry)),
		);
	};

	// The YAML between the file's opening `---` and the next, checked against `fields`, and the
	// body after it with the placeholder filled. A byte-order mark and CRLF line ends are read as
	// an editor meant them.
	const parse = <T>(
		dir: string,
		file: string,
		fields: z.ZodType<T>,
	): Result<{ fields: T; body: string }> => {
		if (basename(file) === ".md")
			return err(new Error(`${file} has no name; name it <name>.md`));
		const size = trySync(() => statSync(join(dir, file)).size);
		if (size.ok && size.value > MAX_BYTES)
			return err(
				new Error(`${file} is over the 16 KiB a copilot file may hold`),
			);
		const raw = trySync(() => readFileSync(join(dir, file), "utf8"));
		if (!raw.ok) return err(new Error(`${file} cannot be read`));
		const text = raw.value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		const [first, ...rest] = text.split("\n");
		const end = rest.findIndex((line) => line.trimEnd() === "---");
		if (first?.trimEnd() !== "---" || end === -1)
			return err(
				new Error(`${file} has no frontmatter between --- lines; add one`),
			);
		const yaml = trySync(() => Bun.YAML.parse(rest.slice(0, end).join("\n")));
		if (!yaml.ok) return err(new Error(`${file}: its frontmatter is not YAML`));
		const parsed = fields.safeParse(yaml.value, {
			error: (issue) => {
				if (issue.code === "unrecognized_keys")
					return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`;
				if (issue.code !== "invalid_type") return undefined;
				if (issue.input === undefined) return "Required";
				const received =
					issue.input === null
						? "null"
						: Array.isArray(issue.input)
							? "array"
							: typeof issue.input;
				return `Expected ${issue.expected}, received ${received}`;
			},
		});
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
			return err(
				new Error(`${file}: invalid frontmatter (${where}${issue?.message})`),
			);
		}
		const body = fill(
			rest
				.slice(end + 1)
				.join("\n")
				.trim(),
			dir,
		);
		return ok({ fields: parsed.data, body });
	};

	/**
	 * A package.json description as the copilot may be shown it: at most 200 characters, and naming
	 * none of base kabane's headings, so an installed directory cannot write into kabane's text.
	 */
	export const description = (
		raw: string | undefined,
	): Result<string | undefined> => {
		if (raw === undefined) return ok(undefined);
		if (raw.length > MAX_DESCRIPTION)
			return err(
				new Error(
					`package.json: its description is over ${MAX_DESCRIPTION} characters, so the copilot is not shown it; shorten it to one sentence`,
				),
			);
		const text = CopilotInstructions.asHeading(raw);
		const heading = CopilotInstructions.HEADINGS.find((h) => text.includes(h));
		if (heading !== undefined)
			return err(
				new Error(
					`package.json: its description contains kabane's heading ${heading}, so the copilot is not shown it; reword it`,
				),
			);
		return ok(raw);
	};

	/**
	 * Every installed extension, enabled or not, with the description the copilot may be shown. A
	 * dropped one leaves the name alone; doctor reports it for an enabled directory extension.
	 */
	export const installed = (
		home: string,
	): Promise<CopilotInstructions.Installed[]> =>
		Promise.all(
			Extensions.available(home).map(async (name) => {
				const checked = description(await Extensions.description(home, name));
				return checked.ok && checked.value !== undefined
					? { name, description: checked.value }
					: { name };
			}),
		);

	// A title that reads like one of base kabane's headings would let a file pass for its text.
	const procedureOf = (
		dir: string,
		file: string,
	): Result<CopilotInstructions.Procedure> => {
		const read = parse(dir, file, ProcedureFields);
		if (!read.ok) return read;
		const title = fill(read.value.fields.title, dir);
		if (
			CopilotInstructions.HEADINGS.includes(
				CopilotInstructions.asHeading(title),
			)
		)
			return err(
				new Error(
					`${file}: the title ${title} is one of kabane's own procedures; rename it`,
				),
			);
		if (read.value.body === "")
			return err(new Error(`${file}: its body is empty`));
		return ok({ title, body: read.value.body });
	};

	const shortcutOf = (dir: string, file: string): Result<CopilotShortcut> => {
		const read = parse(dir, file, ShortcutFields);
		if (!read.ok) return read;
		if (read.value.body === "" || read.value.body.includes("\n"))
			return err(
				new Error(
					`${file}: its body must be one line, the template dropped into the prompt`,
				),
			);
		return ok({
			name: basename(file, ".md"),
			hint: read.value.fields.hint,
			template: read.value.body,
		});
	};

	// Each file of `sub` through `one`, refusing what it refuses.
	const each = <T>(
		{ name, directory }: Extensions.Directory,
		sub: string,
		one: (dir: string, file: string) => Result<T>,
		refuse: (refusal: Refusal) => void,
	): { file: string; value: T }[] => {
		const files = markdown(directory, sub);
		if (!files.ok) {
			refuse({ name, file: sub, reason: files.error.message });
			return [];
		}
		return files.value.flatMap((file) => {
			const read = one(directory, file);
			if (read.ok) return [{ file, value: read.value }];
			refuse({ name, file, reason: read.error.message });
			return [];
		});
	};

	/**
	 * The procedures and shortcuts of each directory extension, in the order given. A shortcut a
	 * built-in already names is refused, and so is every shortcut of a name two extensions use,
	 * because a human types it and could not tell which one runs.
	 */
	export const read = (extensions: readonly Extensions.Directory[]): Read => {
		const procedures: CopilotInstructions.Contribution[] = [];
		const offered: {
			owner: string;
			file: string;
			shortcut: CopilotShortcut;
		}[] = [];
		const refused: Refusal[] = [];
		const refuse = (refusal: Refusal) => refused.push(refusal);
		for (const extension of extensions) {
			const own = each(extension, PROCEDURES, procedureOf, refuse);
			if (own.length > 0)
				procedures.push({
					extension: extension.name,
					procedures: own.map(({ value }) => value),
				});
			for (const { file, value } of each(
				extension,
				SHORTCUTS,
				shortcutOf,
				refuse,
			))
				offered.push({ owner: extension.name, file, shortcut: value });
		}
		const shortcuts: CopilotShortcut[] = [];
		for (const { owner, file, shortcut } of offered) {
			const others = offered.filter(
				(other) =>
					other.owner !== owner && other.shortcut.name === shortcut.name,
			);
			if (CopilotInstructions.SHORTCUTS.some((s) => s.name === shortcut.name))
				refuse({
					name: owner,
					file,
					reason: `${file}: /${shortcut.name} is a built-in shortcut, which wins; rename the file`,
				});
			else if (others.length > 0)
				refuse({
					name: owner,
					file,
					reason: `${file}: /${shortcut.name} is also a shortcut of ${others.map((other) => other.owner).join(", ")}, so neither is offered; rename one`,
				});
			else shortcuts.push(shortcut);
		}
		return { procedures, shortcuts, refused };
	};
}
