import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Result } from "@cabane/core";
import { settingsPort } from "../context";
import { TRACKER_BLOCK } from "../first-run";
import { project, uncheckedSkills } from "./project";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

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

// What `Templates.stamp("dispatch")` gave on main (e6b8506), as /setup-dispatch wrote it into projects
// before the template left base kabane.
const STAMPED = "dispatch@d93baa46897b";

/** A git project with a stamped dispatch skill, symlinked for Claude Code, and the Tracker block. */
const setup = () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "doctor-project-")));
	folders.push(folder);
	const root = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(root, ".kabane"), { recursive: true });
	mkdirSync(home);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	write(join(root, ".agents/skills/dispatch/SKILL.md"), skill(STAMPED));
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
	const unchecked = async (enabled: readonly string[] = []) =>
		unwrap(await uncheckedSkills(enabled)(ctx));
	return { root, ctx, ids, unchecked };
};

test("a current project has no findings, and none outside a project", async () => {
	const { ctx, ids } = setup();
	expect(await ids()).toEqual([]);
	const outside = await project({ ...ctx, cwd: ctx.home });
	expect(outside).toEqual({ ok: true, value: [] });
});

test("a skill kabane stamped before the move is mentioned while no extension checks it", async () => {
	const { root, unchecked, ids } = setup();
	// The project's own checks never read the skill: it is the dispatch extension's.
	expect(await ids()).toEqual([]);
	const [finding, ...others] = await unchecked();
	expect(others).toEqual([]);
	expect(finding).toMatchObject({
		id: "skill-unchecked",
		severity: "mention",
		path: join(root, ".agents/skills/dispatch/SKILL.md"),
	});
	expect(finding?.summary).toBe(
		".agents/skills/dispatch/SKILL.md (template dispatch) carries a kabane-template stamp, and no enabled extension is named dispatch, so doctor cannot tell whether it is current. It works as written; install and enable the extension that ships the template to check.",
	);
	expect(await unchecked(["dispatch"])).toEqual([]);
});

test("an unstamped skill, a skill of the project's own and no skills at all are not mentioned", async () => {
	const { root, unchecked } = setup();
	writeFileSync(join(root, ".agents/skills/dispatch/SKILL.md"), skill());
	write(join(root, ".agents/skills/own/SKILL.md"), "---\nname: own\n---\n");
	expect(await unchecked()).toEqual([]);
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude"), { recursive: true });
	expect(await unchecked()).toEqual([]);
});

test("a real .claude/skills directory and CRLF are read the same", async () => {
	const { root, unchecked } = setup();
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude/skills/dispatch"));
	write(
		join(root, ".claude/skills/dispatch/SKILL.md"),
		skill(STAMPED).replaceAll("\n", "\r\n"),
	);
	expect((await unchecked()).map(({ path }) => path)).toEqual([
		join(root, ".claude/skills/dispatch/SKILL.md"),
	]);
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
	const { root, ids, ctx } = setup();
	write(
		join(root, "AGENTS.md"),
		`# Project\n\n${BEFORE_JCAB_219}\n\n## Build\n\nbun test\n`,
	);
	expect(await ids()).toEqual(["tracker-block-differs:mention"]);
	expect(unwrap(await project(ctx))[0]?.summary).toContain(
		"The ## Tracker section of AGENTS.md differs from the current block in the guide.",
	);
	write(join(root, "AGENTS.md"), `# Project\n\n${TRACKER_BLOCK}\n\n## Build\n`);
	expect(await ids()).toEqual([]);
	write(join(root, "AGENTS.md"), "# Project\n");
	expect(await ids()).toEqual(["tracker-block-missing:suggest"]);
});

test("CRLF keeps the current Tracker block current", async () => {
	const { root, ids } = setup();
	writeFileSync(
		join(root, "AGENTS.md"),
		`# Project\n\n${TRACKER_BLOCK}\n`.replaceAll("\n", "\r\n"),
	);
	expect(await ids()).toEqual([]);
});
