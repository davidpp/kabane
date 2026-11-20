// The skill this extension writes into a project, the dispatch skill the setup-dispatch skill fills,
// compared with the template it ships. Each finding says only what the comparison showed; re-filling
// the skill stays the setup-dispatch skill's job, so doctor routes there instead of writing it. The ids, severities and routes are the ones these checks had
// in base kabane, so a project's findings read the same once the extension is enabled.
import {
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
	const SETUP = "the setup-dispatch skill (/setup-dispatch on the board)";

	/** `metadata.kabane-template` from a skill's YAML frontmatter, if it has one. */
	type StampOf = (skill: string) => string | undefined;

	const isRealDirectory = (path: string): boolean =>
		existsSync(path) && lstatSync(path).isDirectory();

	const isAbsent = (path: string): boolean =>
		!trySync(() => lstatSync(path)).ok;

	/**
	 * Codex, Pi, opencode and Gemini read .agents/skills; Claude Code reads only .claude/skills.
	 * A project with a .claude/ directory uses Claude Code, so a skill under .agents/skills with no
	 * .claude/skills link is one its Claude sessions never list. Setup creates that link
	 * only when .claude/ exists, and this checks the same condition.
	 */
	const claudeLink = (root: string, name: string): Doctor.Finding[] => {
		const link = join(root, ".claude/skills", name);
		const skill = join(root, ".agents/skills", name);
		if (
			!isRealDirectory(join(root, ".claude")) ||
			!existsSync(join(skill, "SKILL.md"))
		)
			return [];
		// A real directory here is the legacy layout dispatch-skill-location reports; a symlink
		// counts only when it resolves to the .agents copy, not to some other SKILL.md.
		if (
			existsSync(join(link, "SKILL.md")) &&
			(!lstatSync(link).isSymbolicLink() ||
				realpathSync(link) === realpathSync(skill))
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
					".claude/skills/dispatch is a directory, so Codex, Pi and Gemini do not read it; the skill belongs in .agents/skills/dispatch with .claude/skills/dispatch as a symlink to it. The setup-dispatch skill offers the move and waits for a yes.",
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
				summary: `${shown} has no kabane-template in its frontmatter metadata, so which template it was filled from is unknown. The setup-dispatch skill re-fills it from ${current.value}, keeping the project's own edits, and shows the diff before writing.`,
				route: SETUP,
			});
		else if (stamp !== current.value)
			findings.push({
				id: "dispatch-skill-behind",
				path,
				severity: "route",
				summary: `${shown} was filled from ${stamp}; the template is now ${current.value}. The setup-dispatch skill re-fills it, keeping the project's own edits, and shows the diff before writing.`,
				route: SETUP,
			});
		return findings;
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
