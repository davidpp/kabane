/**
 * The skills `kabane mcp` serves through `kabane_skillList` and `kabane_skillGet` (wiki/adr/0004):
 * base kabane's own `kabane` skill, and those enabled directory extensions ship as
 * `skills/<name>/SKILL.md` plus the files beside it, in the Agent Skills format. A file convention
 * of this host, as `copilot/` is: the extension contract has no field for it. A skill that cannot
 * be served is refused on its own, with one line naming the extension and the skill, and the rest
 * are served.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CopilotInstructions } from "@cabane/board/copilot-instructions";
import {
	defineTool,
	err,
	ok,
	type Result,
	type ToolDef,
	trySync,
} from "@cabane/core";
import { z } from "zod";
import BASE_ENTRY from "../skills/kabane/SKILL.md" with { type: "text" };
// Imported as text, not read from beside the source: a compiled kabane has no source tree.
import BASE_CONFIG from "../skills/kabane/references/config.md" with { type: "text" };
import BASE_DOCTOR from "../skills/kabane/references/doctor.md" with { type: "text" };
import BASE_LINKING from "../skills/kabane/references/linking.md" with { type: "text" };
import { CopilotFiles } from "./copilot-files";
import type { Extensions } from "./extensions";

const SKILLS = "skills";
const ENTRY = "SKILL.md";

// The Agent Skills limits: a name of lowercase words joined by single hyphens, at most 64
// characters, and a description of at most 1024. Other fields are the skill's own and pass.
const Fields = z.object({
	name: z
		.string()
		.max(64)
		.regex(
			/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
			"must be lowercase letters and digits joined by single hyphens",
		),
	description: z.string().trim().min(1).max(1024),
});

// Functions, not strings: a replacement string reads `$&` or `$$` in a path as a pattern.
// Base kabane's skill has no extension directory, so it leaves `{{extension}}` alone.
const fill = (
	text: string,
	extension: string | undefined,
	kabane: string,
): string =>
	(extension === undefined
		? text
		: text.replaceAll("{{extension}}", () => extension)
	).replaceAll("{{kabane}}", () => kabane);

const outside = (path: string): boolean =>
	path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

// Base kabane's own skill, by its files' paths under the skill.
const BASE_FILES: Readonly<Record<string, string>> = {
	[ENTRY]: BASE_ENTRY,
	"references/config.md": BASE_CONFIG,
	"references/doctor.md": BASE_DOCTOR,
	"references/linking.md": BASE_LINKING,
};
const BASE = "kabane";

export namespace Skills {
	export type Skill = {
		name: string;
		description: string;
		/** The extension that ships it, by the name `extensions` takes; `kabane` for base kabane's. */
		extension: string;
	} & (
		| {
				/** The extension's directory, which `{{extension}}` stands for. */
				root: string;
				/** `<root>/skills/<name>`. */
				directory: string;
		  }
		| { files: Readonly<Record<string, string>> }
	);

	const base = CopilotFiles.frontmatter(
		join(SKILLS, BASE, ENTRY),
		BASE_ENTRY,
		Fields,
	);

	type Read = { skills: Skill[]; refused: CopilotFiles.Refusal[] };

	/** The shell words that run the kabane this server runs, against its KABANE_HOME. */
	export const command = (home: string, executable: string): string =>
		`KABANE_HOME=${CopilotInstructions.shellWord(home)} ${CopilotInstructions.shellWord(executable)}`;

	const one = (root: string, entry: string): Result<z.infer<typeof Fields>> => {
		const dir = join(SKILLS, entry);
		const stat = trySync(() => statSync(join(root, dir)));
		if (!stat.ok || !stat.value.isDirectory())
			return err(new Error(`${dir} must be a directory holding ${ENTRY}`));
		const file = join(dir, ENTRY);
		const raw = trySync(() => readFileSync(join(root, file), "utf8"));
		if (!raw.ok)
			return err(new Error(`${file} cannot be read; a skill needs one`));
		const read = CopilotFiles.frontmatter(file, raw.value, Fields);
		if (!read.ok) return read;
		if (read.value.fields.name !== entry)
			return err(
				new Error(
					`${file}: its name ${read.value.fields.name} is not its directory's; name both alike`,
				),
			);
		return ok(read.value.fields);
	};

	/**
	 * Base kabane's skill, then the skills of each directory extension, in the order given and by
	 * name within one. A name two extensions ship is refused in both, and one base kabane ships is
	 * refused in the extension, because a session asks for it by name and could not tell which one
	 * it gets.
	 */
	export const read = (extensions: readonly Extensions.Directory[]): Read => {
		const found: Skill[] = [];
		const refused: CopilotFiles.Refusal[] = [];
		const skills: Skill[] = [];
		// Its text is fixed at build time, and its tests hold its frontmatter.
		if (base.ok)
			skills.push({
				...base.value.fields,
				extension: BASE,
				files: BASE_FILES,
			});
		for (const { name: extension, directory: root } of extensions) {
			const stat = trySync(() => statSync(join(root, SKILLS)));
			if (!stat.ok) continue;
			const entries = stat.value.isDirectory()
				? trySync(() => readdirSync(join(root, SKILLS)))
				: err(new Error(`${SKILLS} must be a directory; it is a file`));
			if (!entries.ok) {
				refused.push({
					name: extension,
					file: SKILLS,
					reason: stat.value.isDirectory()
						? `${SKILLS} cannot be listed; make it readable`
						: entries.error.message,
				});
				continue;
			}
			for (const entry of entries.value
				.filter((entry) => !entry.startsWith("."))
				.sort()) {
				const skill = one(root, entry);
				if (skill.ok)
					found.push({
						...skill.value,
						extension,
						root,
						directory: join(root, SKILLS, entry),
					});
				else
					refused.push({
						name: extension,
						file: join(SKILLS, entry),
						reason: skill.error.message,
					});
			}
		}
		for (const skill of found) {
			const others = found.filter(
				(other) =>
					other.extension !== skill.extension && other.name === skill.name,
			);
			if (skill.name === BASE)
				refused.push({
					name: skill.extension,
					file: join(SKILLS, skill.name),
					reason: `${join(SKILLS, skill.name)}: kabane itself ships a skill named ${BASE}, so this one is not served; rename it`,
				});
			else if (others.length === 0) skills.push(skill);
			else
				refused.push({
					name: skill.extension,
					file: join(SKILLS, skill.name),
					reason: `${join(SKILLS, skill.name)}: ${others.map((other) => other.extension).join(", ")} also ships a skill named ${skill.name}, so neither is served; rename one`,
				});
		}
		return { skills, refused };
	};

	// Every regular file under the skill's directory by its `/` path from there, hidden ones left
	// out. A link is left out too: it may lead out of the skill. A directory that cannot be listed
	// is left out, so one unreadable entry does not keep the rest of the skill from being served.
	const files = (directory: string, under = ""): string[] => {
		const entries = trySync(() =>
			readdirSync(join(directory, under), { withFileTypes: true }),
		);
		if (!entries.ok) return [];
		return entries.value
			.filter((entry) => !entry.name.startsWith("."))
			.flatMap((entry) => {
				const path = under === "" ? entry.name : `${under}/${entry.name}`;
				if (entry.isDirectory()) return files(directory, path);
				return entry.isFile() ? [path] : [];
			})
			.sort();
	};

	export type Got = {
		name: string;
		extension: string;
		file: string;
		text: string;
		/** The skill's other files, which `file` reads. */
		files: string[];
	};

	/** One file of a skill, `SKILL.md` by default, with `{{extension}}` and `{{kabane}}` filled. */
	export const get = (
		skills: readonly Skill[],
		name: string,
		file: string | undefined,
		kabane: string,
	): Result<Got> => {
		const skill = skills.find((skill) => skill.name === name);
		if (!skill)
			return err(
				new Error(
					`No skill is named ${name}; kabane_skillList names the skills served`,
				),
			);
		const asked = file ?? ENTRY;
		const refuse = err(
			new Error(
				`${asked} is not a file of the skill ${name}; ask for SKILL.md or one of the files it lists`,
			),
		);
		if ("files" in skill) {
			const text = skill.files[asked];
			if (text === undefined) return refuse;
			return ok({
				name,
				extension: skill.extension,
				file: asked,
				text: fill(text, undefined, kabane),
				files: Object.keys(skill.files)
					.filter((other) => other !== asked)
					.sort(),
			});
		}
		if (outside(relative(skill.directory, join(skill.directory, asked))))
			return refuse;
		const root = trySync(() => realpathSync(skill.directory));
		const real = trySync(() => realpathSync(join(skill.directory, asked)));
		if (!root.ok || !real.ok) return refuse;
		const path = relative(root.value, real.value);
		const stat = trySync(() => statSync(real.value));
		// A hidden file is not one of the skill's files, as the manifest leaves it out.
		if (
			path === "" ||
			outside(path) ||
			path.split(sep).some((part) => part.startsWith(".")) ||
			!stat.ok ||
			!stat.value.isFile()
		)
			return refuse;
		const text = trySync(() => readFileSync(real.value, "utf8"));
		if (!text.ok) return err(new Error(`${asked} cannot be read`));
		const own = path.split(sep).join("/");
		return ok({
			name,
			extension: skill.extension,
			file: own,
			text: fill(text.value, skill.root, kabane),
			files: files(root.value).filter((other) => other !== own),
		});
	};

	/**
	 * `kabane_skillList` and `kabane_skillGet`, re-reading the extensions' skills on each call so an
	 * edit is served without a restart.
	 */
	export const tools = (
		extensions: readonly Extensions.Directory[],
		kabane: string,
	): ToolDef[] => [
		defineTool({
			name: "kabane_skillList",
			description:
				"List the skills kabane and its enabled extensions ship: how-to for a task, such as setting something up, to fetch with kabane_skillGet when that task comes up or the human names it. Each has its name, a description of when to use it, and the extension that ships it, kabane for kabane's own.",
			input: {},
			kind: "read",
			handler: async () =>
				ok({
					skills: read(extensions).skills.map(
						({ name, description, extension }) => ({
							name,
							description,
							extension,
						}),
					),
				}),
		}),
		defineTool({
			name: "kabane_skillGet",
			description:
				"Read a skill to follow it: its SKILL.md, or with file one of the other files it names, by its path under the skill. Returns text, with the kabane command to run in your shell and the extension's directory already filled in, and files, the skill's other files. A path outside the skill is refused.",
			input: {
				name: z.string().min(1),
				file: z
					.string()
					.min(1)
					.optional()
					.describe("A path under the skill, as files lists it."),
			},
			kind: "read",
			handler: async ({ name, file }) =>
				get(read(extensions).skills, name, file, kabane),
		}),
	];

	/** The server instructions' line naming the tools. */
	export const INSTRUCTIONS =
		"kabane and its enabled extensions ship skills, how-to for kabane tasks: setting up or configuring kabane or one of its extensions in a project, linking an issue to Linear or GitHub, changing kabane's settings, checking it with doctor, or going through an issue's open questions. When the human asks for a kabane task or names a kabane command or extension, call kabane_skillList before running kabane's help or reading its files, and when a skill's description matches, follow what kabane_skillGet returns instead of improvising.";
}
