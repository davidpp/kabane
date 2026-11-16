// What kabane writes into a project, compared with what this kabane ships: the `## Tracker` block of
// the instruction files. A skill an extension filled from its template carries that template's
// stamp; the extension checks it, and with no such extension enabled doctor says it cannot.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { ok, type Result, trySync } from "@cabane/core";
import type { Doctor, Extension } from "@cabane/extension";
import { projectAt } from "../context";
import { McpClients } from "../mcp-clients";

const TRACKER_GUIDE =
	"https://github.com/davidpp/kabane/blob/main/docs/getting-started.md";

/** The `## Tracker` section of `text`: up to the next heading of the same or a higher level. */
const trackerSection = (text: string): string | undefined => {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^## Tracker\s*$/.test(line));
	if (start === -1) return undefined;
	const end = lines.findIndex(
		(line, index) => index > start && /^#{1,2}\s/.test(line),
	);
	return lines
		.slice(start, end === -1 ? undefined : end)
		.join("\n")
		.trimEnd();
};

const trackerBlock = (root: string, block: string): Doctor.Finding[] => {
	const files = McpClients.IDS.map((id) => McpClients.entry(id).instructionFile)
		.map((name) => ({ name, path: join(root, name) }))
		.filter(({ path }) => existsSync(path));
	const sections = files.flatMap(({ name, path }) => {
		const section = trackerSection(readFileSync(path, "utf8"));
		return section === undefined ? [] : [{ name, path, section }];
	});
	if (sections.length === 0)
		return [
			{
				id: "tracker-block-missing",

				severity: "suggest",
				summary:
					"No CLAUDE.md, AGENTS.md or GEMINI.md here has a ## Tracker section; agents use kabane unprompted only when the project tells them to. Add the current block from the linked guide.",
				route: `Read the Tracker block at ${TRACKER_GUIDE} and add it to the project instruction file.`,
			},
		];
	const differing = sections.filter(({ section }) => section !== block);
	if (differing.length === 0) return [];
	return [
		{
			id: "tracker-block-differs",

			path: differing[0]?.path,
			severity: "mention",
			summary: `The ## Tracker section of ${differing.map(({ name }) => name).join(", ")} differs from the current block in the guide. It may hold the project's own edits, or come from an older kabane. Compare the blocks and preserve deliberate project edits.`,
			route: `Read the current Tracker block at ${TRACKER_GUIDE}`,
		},
	];
};

export const project = async (
	ctx: Extension.Ctx,
): Promise<Result<Doctor.Finding[]>> => {
	const here = await projectAt(ctx.cwd, ctx.home);
	if (!here.ok) return here;
	if (here.value === null) return ok([]);
	// first-run carries the board's setup screen; main loads it lazily, and so does this check.
	const { TRACKER_BLOCK } = await import("../first-run");
	const { root } = here.value;
	const found = trySync(() => trackerBlock(root, TRACKER_BLOCK));
	return ok(
		found.ok
			? found.value
			: [
					{
						id: "tracker-check-failed",
						severity: "mention",
						summary: found.error.message,
					},
				],
	);
};

/** The template a skill was filled from: `<name>` of `kabane-template: <name>@<hash>` in its frontmatter. */
const templateOf = (skill: string): string | undefined => {
	const lines = skill.split(/\r?\n/);
	if (lines[0]?.trimEnd() !== "---") return undefined;
	const end = lines.findIndex(
		(line, index) => index > 0 && line.trimEnd() === "---",
	);
	return lines
		.slice(1, end === -1 ? 1 : end)
		.map(
			(line) =>
				/^\s+kabane-template:\s*["']?([\w-]+)@[0-9a-f]+/.exec(line)?.[1],
		)
		.find((name) => name !== undefined);
};

/** Each project skill's SKILL.md, once: a `.claude/skills` entry is usually a link to the `.agents` one. */
const skillFiles = (root: string): string[] => [
	...new Set(
		[".agents/skills", ".claude/skills"].flatMap((dir) => {
			const names = trySync(() => readdirSync(join(root, dir)));
			return (names.ok ? names.value : [])
				.map((name) => join(root, dir, name, "SKILL.md"))
				.filter((path) => existsSync(path))
				.map((path) => realpathSync(path));
		}),
	),
];

/**
 * The project's skills filled from a template that no enabled extension named like it checks. They
 * work as they are; doctor only cannot say whether they are current, and says that.
 */
export const uncheckedSkills =
	(checked: readonly string[]): Doctor.Source["doctor"] =>
	async (ctx) => {
		const here = await projectAt(ctx.cwd, ctx.home);
		if (!here.ok) return here;
		if (here.value === null) return ok([]);
		const { root } = here.value;
		const unchecked = skillFiles(root).flatMap((path) => {
			const name = templateOf(readFileSync(path, "utf8"));
			return name === undefined || checked.includes(name)
				? []
				: [{ path, name }];
		});
		if (unchecked.length === 0) return ok([]);
		const one = unchecked.length === 1;
		const listed = unchecked
			.map(({ path, name }) => `${relative(root, path)} (template ${name})`)
			.join(", ");
		const names = [...new Set(unchecked.map(({ name }) => name))].join(", ");
		return ok([
			{
				id: "skill-unchecked",
				path: unchecked[0]?.path,
				severity: "mention",
				summary: `${listed} ${one ? "carries" : "carry"} a kabane-template stamp, and no enabled extension is named ${names}, so doctor cannot tell whether ${one ? "it is" : "they are"} current. ${one ? "It works" : "They work"} as written; install and enable the extension that ships the template to check.`,
			},
		]);
	};
