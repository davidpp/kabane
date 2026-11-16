/**
 * What an enabled directory extension adds to the board's copilot, read from markdown files in its
 * directory rather than from its code: `copilot/procedures/<name>.md` (frontmatter `title`) is
 * appended to the copilot's instructions, and `copilot/shortcuts/<name>.md` (frontmatter `hint`,
 * a one-line body) is offered as `/<name>`. `{{extension}}` in a body or a procedure's title
 * becomes the extension's directory and nothing else is substituted. A file that cannot be used is refused on its own,
 * with one line naming the extension and the file, and the rest loads.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CopilotInstructions } from "@cabane/board/copilot-instructions";
import { err, ok, type Result, trySync } from "@cabane/core";
import type { CopilotShortcut } from "@cabane/extension";
import { z } from "zod";
import type { Extensions } from "./extensions";

// Strict, so a file has no field for a harness mode, an allow list or an MCP entry: a procedure
// cannot carry a permission policy in its type.
const ProcedureFields = z.object({ title: z.string().trim().min(1) }).strict();
const ShortcutFields = z.object({ hint: z.string().trim().min(1) }).strict();

const PROCEDURES = join("copilot", "procedures");
const SHORTCUTS = join("copilot", "shortcuts");
const PLACEHOLDER = "{{extension}}";

// A function, not a string: a replacement string reads `$&` or `$$` in the path as a pattern.
const fill = (text: string, dir: string): string =>
	text.replaceAll(PLACEHOLDER, () => dir);

export namespace CopilotFiles {
	type Read = {
		procedures: CopilotInstructions.Contribution[];
		shortcuts: CopilotShortcut[];
		refused: Extensions.Refusal[];
	};

	// The markdown files of one of an extension's copilot directories, by name, so the copilot
	// reads them in the same order on every device. An absent directory contributes nothing.
	const markdown = (dir: string, sub: string): Result<string[]> => {
		if (!existsSync(join(dir, sub))) return ok([]);
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
	// body after it with the placeholder filled.
	const parse = <T>(
		dir: string,
		file: string,
		fields: z.ZodType<T>,
	): Result<{ fields: T; body: string }> => {
		const raw = trySync(() => readFileSync(join(dir, file), "utf8"));
		if (!raw.ok) return err(new Error(`${file} cannot be read`));
		const [first, ...rest] = raw.value.split("\n");
		const end = rest.findIndex((line) => line.trimEnd() === "---");
		if (first?.trimEnd() !== "---" || end === -1)
			return err(
				new Error(`${file} has no frontmatter between --- lines; add one`),
			);
		const yaml = trySync(() => Bun.YAML.parse(rest.slice(0, end).join("\n")));
		if (!yaml.ok) return err(new Error(`${file}: its frontmatter is not YAML`));
		const parsed = fields.safeParse(yaml.value);
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
		const refused: Extensions.Refusal[] = [];
		const refuse = (name: string, reason: string) =>
			refused.push({ name, reason });
		for (const { name, directory } of extensions) {
			const own: CopilotInstructions.Procedure[] = [];
			const files = markdown(directory, PROCEDURES);
			if (!files.ok) refuse(name, files.error.message);
			for (const file of files.ok ? files.value : []) {
				const read = parse(directory, file, ProcedureFields);
				if (read.ok)
					own.push({
						title: fill(read.value.fields.title, directory),
						body: read.value.body,
					});
				else refuse(name, read.error.message);
			}
			if (own.length > 0) procedures.push({ extension: name, procedures: own });
			const shortcuts = markdown(directory, SHORTCUTS);
			if (!shortcuts.ok) refuse(name, shortcuts.error.message);
			for (const file of shortcuts.ok ? shortcuts.value : []) {
				const read = parse(directory, file, ShortcutFields);
				if (!read.ok) {
					refuse(name, read.error.message);
					continue;
				}
				if (read.value.body === "" || read.value.body.includes("\n")) {
					refuse(
						name,
						`${file}: its body must be one line, the template dropped into the prompt`,
					);
					continue;
				}
				offered.push({
					owner: name,
					file,
					shortcut: {
						name: basename(file, ".md"),
						hint: read.value.fields.hint,
						template: read.value.body,
					},
				});
			}
		}
		const shortcuts: CopilotShortcut[] = [];
		for (const { owner, file, shortcut } of offered) {
			const others = offered.filter(
				(other) =>
					other.owner !== owner && other.shortcut.name === shortcut.name,
			);
			if (CopilotInstructions.SHORTCUTS.some((s) => s.name === shortcut.name))
				refuse(
					owner,
					`${file}: /${shortcut.name} is a built-in shortcut, which wins; rename the file`,
				);
			else if (others.length > 0)
				refuse(
					owner,
					`${file}: /${shortcut.name} is also a shortcut of ${others.map((other) => other.owner).join(", ")}, so neither is offered; rename one`,
				);
			else shortcuts.push(shortcut);
		}
		return { procedures, shortcuts, refused };
	};
}
