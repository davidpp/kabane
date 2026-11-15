import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Templates } from "@cabane/acp/templates";
import { Doctor } from "@cabane/extension";
import { settingsPort } from "../context";
import { TRACKER_BLOCK } from "../first-run";
import { kabane } from "./kabane";
import { project } from "./project";

// kabane's checks include the harness registrations; this machine's own are not these tests'.
const harnesses = process.env.KABANE_HARNESSES;
beforeAll(() => {
	process.env.KABANE_HARNESSES = "";
});
afterAll(() => {
	if (harnesses === undefined) delete process.env.KABANE_HARNESSES;
	else process.env.KABANE_HARNESSES = harnesses;
});

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

const skill = (stamp?: string) =>
	`---\nname: dispatch\ndescription: Dispatch.\n${stamp === undefined ? "" : `metadata:\n  kabane-template: ${stamp}\n`}---\n\n# Dispatch\n`;

/** A git project with a current dispatch skill, symlinked for Claude Code, and the Tracker block. */
const setup = () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "doctor-project-")));
	folders.push(folder);
	const root = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(root, ".kabane"), { recursive: true });
	mkdirSync(home);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	write(
		join(root, ".agents/skills/dispatch/SKILL.md"),
		skill(Templates.stamp("dispatch")),
	);
	mkdirSync(join(root, ".claude/skills"), { recursive: true });
	symlinkSync(
		"../../.agents/skills/dispatch",
		join(root, ".claude/skills/dispatch"),
	);
	write(join(root, "AGENTS.md"), `# Project\n\n${TRACKER_BLOCK}\n`);
	const ctx = {
		home,
		store: home,
		cwd: root,
		actor: "",
		harnessMode: "auto" as const,
		settings: settingsPort(home),
	};
	const ids = async () => {
		const found = await project(ctx);
		if (!found.ok) throw found.error;
		return found.value.map(({ id, severity }) => `${id}:${severity}`);
	};
	return { root, ctx, ids };
};

test("a current project has no findings, and none outside a project", async () => {
	const { ctx, ids } = setup();
	expect(await ids()).toEqual([]);
	const outside = await project({ ...ctx, cwd: ctx.home });
	expect(outside).toEqual({ ok: true, value: [] });
});

test("a missing dispatch skill routes to /setup-dispatch", async () => {
	const { root, ids } = setup();
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude"), { recursive: true });
	expect(await ids()).toEqual(["dispatch-skill-missing:suggest"]);
});

test("an unstamped skill and an old stamp are told apart", async () => {
	const { root, ids, ctx } = setup();
	const path = join(root, ".agents/skills/dispatch/SKILL.md");
	writeFileSync(path, skill());
	expect(await ids()).toEqual(["dispatch-skill-unstamped:route"]);
	writeFileSync(path, skill("dispatch@000000000000"));
	expect(await ids()).toEqual(["dispatch-skill-behind:route"]);
	const found = await project(ctx);
	if (!found.ok) throw found.error;
	expect(found.value[0]?.summary).toContain("dispatch@000000000000");
	expect(found.value[0]?.summary).toContain(Templates.stamp("dispatch"));
});

test("a real .claude/skills/dispatch directory is reported, a symlink is not", async () => {
	const { root, ids } = setup();
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude/skills/dispatch"));
	write(
		join(root, ".claude/skills/dispatch/SKILL.md"),
		skill(Templates.stamp("dispatch")),
	);
	expect(await ids()).toEqual(["dispatch-skill-location:route"]);
});

test("an edited grill copy is reported and --fix project/grill-skill-behind restores it", async () => {
	const { root, ctx, ids } = setup();
	const template = readFileSync(join(Templates.dir("grill"), "SKILL.md"));
	const path = join(root, ".agents/skills/grill/SKILL.md");
	write(path, template.toString());
	symlinkSync("../../.agents/skills/grill", join(root, ".claude/skills/grill"));
	expect(await ids()).toEqual([]);
	writeFileSync(path, `${template}\nA project edit.\n`);
	expect(await ids()).toEqual(["grill-skill-behind:mention"]);
	const unasked = await Doctor.run([kabane], ctx, { fix: true });
	expect(unasked.fixes).toEqual([]);
	const report = await Doctor.run([kabane], ctx, {
		fix: ["project/grill-skill-behind"],
	});
	expect(report.fixes).toHaveLength(1);
	expect(report.fixes[0]?.result.ok).toBe(true);
	expect(readFileSync(path).equals(template)).toBe(true);
	expect(await ids()).toEqual([]);
});

// The block as first-run.ts wrote it before JCAB-219 (ce77e64^), when finishing meant a comment.
const BEFORE_JCAB_219 = [
	"## Tracker",
	"",
	"Work is tracked in kabane (MCP server `kabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.",
	'- Before starting, `kabane_list` with `assignee` set to your name, `state: "next"`, and `responseFormat: "concise"`. If no suitable task is on the page and `hasMore` is true, follow `nextCursor` with the same filters; only assert no work remains after `hasMore` is false. Read the chosen task with `kabane_context` and `responseFormat: "concise"`; consume every preceding chunk and continue with `nextCursor` until `selectedComplete`, `descriptionComplete`, and `humanSteeringComplete` are true before starting work. Use the same id/options; request any omitted required sections.',
	'- Set the task `in_progress` with `kabane_edit` and `responseFormat: "concise"` before touching code. Never take a task that is already in progress.',
	'- When finished, `kabane_comment` with `body` describing what landed (files, commits, what is left). Check write results for errors before `kabane_done` with `responseFormat: "concise"`.',
	'- File new work you find with `kabane_add` and `responseFormat: "concise"` instead of doing it unasked. Use `kabane_get` for full own fields.',
].join("\n");

test("a Tracker block from before JCAB-219 is mentioned, a missing one suggested", async () => {
	const { root, ids } = setup();
	write(
		join(root, "AGENTS.md"),
		`# Project\n\n${BEFORE_JCAB_219}\n\n## Build\n\nbun test\n`,
	);
	expect(await ids()).toEqual(["tracker-block-differs:mention"]);
	write(join(root, "AGENTS.md"), `# Project\n\n${TRACKER_BLOCK}\n\n## Build\n`);
	expect(await ids()).toEqual([]);
	write(join(root, "AGENTS.md"), "# Project\n");
	expect(await ids()).toEqual(["tracker-block-missing:suggest"]);
});
