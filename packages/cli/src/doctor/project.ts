// The files kabane writes into a project, compared with what this kabane ships: the dispatch skill
// /setup-dispatch fills, a copy of the grill skill, and the `## Tracker` block of the instruction
// files. Each finding says only what the comparison showed; re-filling the dispatch skill stays
// /setup-dispatch's job, so doctor routes there instead of writing it.
import {
	copyFileSync,
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Templates } from "@cabane/acp/templates";
import { ok, type Result, trySync } from "@cabane/core";
import type { Doctor, Extension } from "@cabane/extension";
import { z } from "zod";
import { projectAt } from "../context";
import { McpClients } from "../mcp-clients";

const SOURCE = "project";
const SETUP = "/setup-dispatch";
const TRACKER_GUIDE =
	"https://github.com/davidpp/kabane/blob/main/docs/getting-started.md";

const FrontmatterSchema = z.object({
	metadata: z.object({ "kabane-template": z.string() }).optional(),
});

/** `metadata.kabane-template` from a skill's YAML frontmatter, if it has one. */
const stampOf = (skill: string): string | undefined => {
	const [first, ...rest] = skill.split("\n");
	if (first?.trimEnd() !== "---") return undefined;
	const end = rest.findIndex((line) => line.trimEnd() === "---");
	if (end === -1) return undefined;
	const parsed = trySync(() => Bun.YAML.parse(rest.slice(0, end).join("\n")));
	if (!parsed.ok) return undefined;
	const fields = FrontmatterSchema.safeParse(parsed.value);
	return fields.success ? fields.data.metadata?.["kabane-template"] : undefined;
};

const isRealDirectory = (path: string): boolean =>
	existsSync(path) && lstatSync(path).isDirectory();

const dispatchSkill = (root: string): Doctor.Finding[] => {
	const claudeDir = join(root, ".claude/skills/dispatch");
	const path = [
		join(root, ".agents/skills/dispatch/SKILL.md"),
		join(claudeDir, "SKILL.md"),
	].find((candidate) => existsSync(candidate));
	if (path === undefined)
		return [
			{
				id: "dispatch-skill-missing",

				severity: "suggest",
				summary:
					"No dispatch skill in .agents/skills/dispatch or .claude/skills/dispatch.",
				route: `${SETUP} writes one`,
			},
		];
	const findings: Doctor.Finding[] = [];
	if (isRealDirectory(claudeDir))
		findings.push({
			id: "dispatch-skill-location",

			path: claudeDir,
			severity: "route",
			summary:
				".claude/skills/dispatch is a directory, so only Claude Code reads it; the skill belongs in .agents/skills/dispatch with .claude/skills/dispatch as a symlink to it. /setup-dispatch offers the move and waits for a yes.",
			route: SETUP,
		});
	const shown = relative(root, path);
	const stamp = stampOf(readFileSync(path, "utf8"));
	const current = Templates.stamp("dispatch");
	if (!current.ok)
		return [
			...findings,
			{
				id: "dispatch-template-unavailable",

				path: Templates.dir("dispatch"),
				severity: "mention",
				summary: `Cannot read the shipped dispatch template: ${current.error.message}. Restore the templates directory from this kabane installation.`,
			},
		];
	if (stamp === undefined)
		findings.push({
			id: "dispatch-skill-unstamped",

			path,
			severity: "route",
			summary: `${shown} has no kabane-template in its frontmatter metadata, so which template it was filled from is unknown. /setup-dispatch re-fills it from ${current.value}, keeping the project's own edits, and shows the diff before writing.`,
			route: SETUP,
		});
	else if (stamp !== current.value)
		findings.push({
			id: "dispatch-skill-behind",

			path,
			severity: "route",
			summary: `${shown} was filled from ${stamp}; the template is now ${current.value}. /setup-dispatch re-fills it, keeping the project's own edits, and shows the diff before writing.`,
			route: SETUP,
		});
	return findings;
};

const grillSkill = (root: string): Doctor.Finding[] => {
	const template = join(Templates.dir("grill"), "SKILL.md");
	const shipped = readFileSync(template);
	// The .claude path is usually a symlink to the .agents copy: one file, compared once.
	const copies = [
		...new Set(
			[".agents/skills/grill/SKILL.md", ".claude/skills/grill/SKILL.md"]
				.map((path) => join(root, path))
				.filter((path) => existsSync(path))
				.map((path) => realpathSync(path)),
		),
	];
	const behind = copies.filter((path) => !readFileSync(path).equals(shipped));
	if (behind.length === 0) return [];
	const shown = behind.map((path) => relative(root, path)).join(", ");
	return [
		{
			id: "grill-skill-behind",

			path: behind[0],
			severity: "mention",
			summary: `${shown} differs from the grill skill this kabane ships. --fix ${SOURCE}/grill-skill-behind copies the template over it, replacing any edits of the project's own.`,
			fix: async () =>
				trySync(() => {
					for (const path of behind) copyFileSync(template, path);
					return `Copied the grill skill template to ${shown}`;
				}),
		},
	];
};

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
	const { root } = here.value;
	// first-run carries the board's setup screen; main loads it lazily, and so does this check.
	const { TRACKER_BLOCK } = await import("../first-run");
	const findings: Doctor.Finding[] = [];
	for (const [id, check] of [
		["dispatch", () => dispatchSkill(root)],
		["grill", () => grillSkill(root)],
		["tracker", () => trackerBlock(root, TRACKER_BLOCK)],
	] as const) {
		const found = trySync(check);
		if (found.ok) findings.push(...found.value);
		else
			findings.push({
				id: `${id}-check-failed`,

				severity: "mention",
				summary: found.error.message,
			});
	}
	return ok(findings);
};
