// The user-level job skill's check and its fix, over a throwaway home.
import { afterEach, expect, it } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, tryCatch, trySync } from "@kabane/core";
import { JobSkill } from "./job-skill";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
const home = (): string => {
	const made = mkdtempSync(join(tmpdir(), "job-skill-"));
	homes.push(made);
	return made;
};
const shipped = () => readFileSync(JobSkill.template(), "utf8");
const fix = async (finding: { fix?: () => Promise<unknown> } | undefined) =>
	finding?.fix?.();

it("reports a missing skill, and its fix writes it and links Claude Code's directory", async () => {
	const user = home();
	const [missing] = JobSkill.check(user);
	expect(missing).toMatchObject({
		id: "job-skill-missing",
		severity: "suggest",
	});
	expect(await fix(missing)).toEqual(
		ok(
			"Wrote ~/.agents/skills/job/SKILL.md and linked ~/.claude/skills/job to it",
		),
	);
	expect(readFileSync(join(user, ".agents/skills/job/SKILL.md"), "utf8")).toBe(
		shipped(),
	);
	expect(readlinkSync(join(user, ".claude/skills/job"))).toBe(
		"../../.agents/skills/job",
	);
	expect(readFileSync(join(user, ".claude/skills/job/SKILL.md"), "utf8")).toBe(
		shipped(),
	);
	expect(JobSkill.check(user)).toEqual([]);
});

it("reports an edited copy as behind, and its fix copies the template over it", async () => {
	const user = home();
	await fix(JobSkill.check(user)[0]);
	writeFileSync(join(user, ".agents/skills/job/SKILL.md"), "mine\n");
	const [behind] = JobSkill.check(user);
	expect(behind).toMatchObject({ id: "job-skill-behind", severity: "mention" });
	expect(await fix(behind)).toEqual(
		ok(
			"Wrote ~/.agents/skills/job/SKILL.md; ~/.claude/skills/job is already a link",
		),
	);
	expect(JobSkill.check(user)).toEqual([]);
});

it("leaves a ~/.claude/skills/job that is not a link alone, and says so", async () => {
	const user = home();
	mkdirSync(join(user, ".claude/skills/job"), { recursive: true });
	writeFileSync(join(user, ".claude/skills/job/SKILL.md"), "own\n");
	const fixed = await fix(JobSkill.check(user)[0]);
	expect(fixed).toEqual(
		ok(
			"Wrote ~/.agents/skills/job/SKILL.md; left ~/.claude/skills/job as it is, since it is not a link: Claude Code reads that copy",
		),
	);
	expect(lstatSync(join(user, ".claude/skills/job")).isDirectory()).toBe(true);
	expect(readFileSync(join(user, ".claude/skills/job/SKILL.md"), "utf8")).toBe(
		"own\n",
	);
});
