// The skills this extension writes into a project, compared with the templates it ships: the
// dispatch skill /setup-dispatch fills and a copy of the grill skill. Each finding says only what
// the comparison showed; re-filling the dispatch skill stays /setup-dispatch's job, so doctor
// routes there instead of writing it. The ids, severities and routes are the ones these checks had
// in base kabane, so a project's findings read the same once the extension is enabled.
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Result } from "@cabane/core";
import type { Doctor, Extension, Host } from "@cabane/extension";
import { ok, trySync } from "./result";
import { Templates } from "./templates";

export namespace DispatchDoctor {
	const SETUP = "/setup-dispatch";

	/** `metadata.kabane-template` from a skill's YAML frontmatter, if it has one. */
	type StampOf = (skill: string) => string | undefined;

	const isRealDirectory = (path: string): boolean =>
		existsSync(path) && lstatSync(path).isDirectory();

	const isAbsent = (path: string): boolean =>
		!trySync(() => lstatSync(path)).ok;

	/**
	 * Codex, Pi, opencode and Gemini read .agents/skills; Claude Code reads only .claude/skills.
	 * A project with a .claude/ directory uses Claude Code, so a skill under .agents/skills with no
	 * .claude/skills link is one its Claude sessions never list. The procedures create that link
	 * only when .claude/ exists, and this checks the same condition.
	 */
	const claudeLink = (root: string, name: string): Doctor.Finding[] => {
		const link = join(root, ".claude/skills", name);
		if (
			!isRealDirectory(join(root, ".claude")) ||
			!existsSync(join(root, ".agents/skills", name, "SKILL.md")) ||
			existsSync(join(link, "SKILL.md"))
		)
			return [];
		const target = `../../.agents/skills/${name}`;
		const shown = relative(root, link);
		const absent = isAbsent(link);
		return [
			{
				id: `${name}-skill-unlinked`,
				path: link,
				severity: "mention",
				summary: absent
					? `.agents/skills/${name} has no ${shown} link, so Claude Code, which reads only .claude/skills, does not list the ${name} skill. --fix dispatch/${name}-skill-unlinked links ${shown} to ${target}.`
					: `${shown} does not lead to .agents/skills/${name}/SKILL.md, so Claude Code does not list the ${name} skill. Replace it with a link to ${target}.`,
				...(absent && {
					fix: async () =>
						trySync(() => {
							mkdirSync(join(root, ".claude/skills"), { recursive: true });
							symlinkSync(target, link);
							return `Linked ${shown} to ${target}`;
						}),
				}),
			},
		];
	};

	const stampReader = (host: Host): StampOf => {
		const FrontmatterSchema = host.z.object({
			metadata: host.z
				.object({ "kabane-template": host.z.string() })
				.optional(),
		});
		return (skill) => {
			const [first, ...rest] = skill.split("\n");
			if (first?.trimEnd() !== "---") return undefined;
			const end = rest.findIndex((line) => line.trimEnd() === "---");
			if (end === -1) return undefined;
			const parsed = trySync(() =>
				Bun.YAML.parse(rest.slice(0, end).join("\n")),
			);
			if (!parsed.ok) return undefined;
			const fields = FrontmatterSchema.safeParse(parsed.value);
			return fields.success
				? fields.data.metadata?.["kabane-template"]
				: undefined;
		};
	};

	const dispatchSkill = (root: string, stampOf: StampOf): Doctor.Finding[] => {
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
					".claude/skills/dispatch is a directory, so Codex, Pi and Gemini do not read it; the skill belongs in .agents/skills/dispatch with .claude/skills/dispatch as a symlink to it. /setup-dispatch offers the move and waits for a yes.",
				route: SETUP,
			});
		const shown = relative(root, path);
		const stamp = stampOf(readFileSync(path, "utf8"));
		const current = Templates.stamp();
		if (!current.ok)
			return [
				...findings,
				{
					id: "dispatch-template-unavailable",
					path: Templates.dir("dispatch"),
					severity: "mention",
					summary: `Cannot read the dispatch template this extension ships: ${current.error.message}. Reinstall the dispatch extension.`,
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
				summary: `${shown} differs from the grill skill the dispatch extension ships. --fix dispatch/grill-skill-behind copies the template over it, replacing any edits of the project's own.`,
				fix: async () =>
					trySync(() => {
						for (const path of behind) copyFileSync(template, path);
						return `Copied the grill skill template to ${shown}`;
					}),
			},
		];
	};

	/** The checks, with the frontmatter schema built on the host's zod. */
	export const create = (host: Host): Doctor.Source["doctor"] => {
		const stampOf = stampReader(host);
		return async (ctx: Extension.Ctx): Promise<Result<Doctor.Finding[]>> => {
			const here = await host.scope.detect(ctx.cwd);
			if (!here.ok) return here;
			if (here.value === null) return ok([]);
			const { root } = here.value;
			const findings: Doctor.Finding[] = [];
			for (const [id, check] of [
				["dispatch", () => dispatchSkill(root, stampOf)],
				["dispatch-link", () => claudeLink(root, "dispatch")],
				["grill", () => grillSkill(root)],
				["grill-link", () => claudeLink(root, "grill")],
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
	};
}
