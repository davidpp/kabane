// The `job` skill at user level, where every harness in every folder reads it: ~/.agents/skills/job
// (Codex, Pi, opencode, Gemini) and a ~/.claude/skills/job link to it (Claude Code reads only its
// own directory). It belongs to the harnesses, so it is never under KABANE_HOME.
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Doctor } from "@cabane/extension";
import { trySync } from "./result";

export namespace JobSkill {
	// The extension's own templates/. The build flattens src/ into index.js beside it and rewrites
	// this URL to match (scripts/build.ts).
	const TEMPLATES = new URL("../templates/", import.meta.url);

	/** The shipped skill. */
	export const template = (): string =>
		fileURLToPath(new URL("job/SKILL.md", TEMPLATES));

	const exists = (path: string): boolean => trySync(() => lstatSync(path)).ok;

	/** Write the template and link Claude Code's directory to it; what it did, as one line. */
	const install = (home: string): string => {
		const dir = join(home, ".agents/skills/job");
		mkdirSync(dir, { recursive: true });
		copyFileSync(template(), join(dir, "SKILL.md"));
		const link = join(home, ".claude/skills/job");
		if (exists(link)) {
			return lstatSync(link).isSymbolicLink()
				? `Wrote ~/.agents/skills/job/SKILL.md; ~/.claude/skills/job is already a link`
				: `Wrote ~/.agents/skills/job/SKILL.md; left ~/.claude/skills/job as it is, since it is not a link: Claude Code reads that copy`;
		}
		mkdirSync(join(home, ".claude/skills"), { recursive: true });
		symlinkSync("../../.agents/skills/job", link);
		return `Wrote ~/.agents/skills/job/SKILL.md and linked ~/.claude/skills/job to it`;
	};

	/** `job-skill-missing` or `job-skill-behind`, or nothing when the copy matches the template. */
	export const check = (home = homedir()): Doctor.Finding[] => {
		const path = join(home, ".agents/skills/job/SKILL.md");
		if (!existsSync(path))
			return [
				{
					id: "job-skill-missing",
					path,
					severity: "suggest",
					summary:
						"No job skill in ~/.agents/skills/job, so a harness outside a project with one does not know how to make a kabane job. --fix recipes/job-skill-missing writes it and links ~/.claude/skills/job to it.",
					fix: async () => trySync(() => install(home)),
				},
			];
		if (readFileSync(path).equals(readFileSync(template()))) return [];
		return [
			{
				id: "job-skill-behind",
				path,
				severity: "mention",
				summary:
					"~/.agents/skills/job/SKILL.md differs from the job skill the recipes extension ships. --fix recipes/job-skill-behind copies the template over it, replacing any edits of your own.",
				fix: async () => trySync(() => install(home)),
			},
		];
	};
}
