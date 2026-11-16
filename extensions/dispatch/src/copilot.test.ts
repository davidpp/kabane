// The copilot files and templates are prose, so what is testable about them is what the copilot and
// a coding session depend on: the paths a procedure names exist in this directory, every
// placeholder is documented, the stamp comes from a command, and the tool names a procedure is only
// correct if it names. The host fills `{{extension}}`; here the files are read as they ship.
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXTENSION = resolve(import.meta.dir, "..");
const read = (path: string): string =>
	readFileSync(join(EXTENSION, path), "utf8");
const body = (path: string): string => read(path).split("\n---\n")[1] ?? "";
const flat = (text: string): string => text.replace(/\s+/g, " ");

const SETUP = body("copilot/procedures/setup-dispatch.md");
const GRILLING = body("copilot/procedures/grilling.md");
const template = (path: string): string => read(`templates/dispatch/${path}`);
const grill = (): string => read("templates/grill/SKILL.md");

// What the copilot copies into a project, as opposed to PLACEHOLDERS.md, which it only reads.
const SKILL_FILES = [
	"SKILL.md",
	"references/issue-template.md",
	"references/agent-prompt.md",
	"references/specialists.md",
];

describe("the copilot files", () => {
	it("are the two procedures and the one shortcut, titled as the copilot reads them", () => {
		expect(readdirSync(join(EXTENSION, "copilot/procedures")).sort()).toEqual([
			"grilling.md",
			"setup-dispatch.md",
		]);
		expect(read("copilot/procedures/setup-dispatch.md")).toStartWith(
			"---\ntitle: SETTING UP A DISPATCH SKILL\n---\n",
		);
		expect(read("copilot/procedures/grilling.md")).toStartWith(
			"---\ntitle: GRILLING\n---\n",
		);
		expect(readdirSync(join(EXTENSION, "copilot/shortcuts"))).toEqual([
			"setup-dispatch.md",
		]);
	});

	it("name only paths this directory ships, through {{extension}}", () => {
		expect(SETUP).toContain("{{extension}}/templates/dispatch:");
		expect(GRILLING).toContain("{{extension}}/templates/grill/SKILL.md:");
		for (const path of [...SKILL_FILES, "PLACEHOLDERS.md"])
			expect(existsSync(join(EXTENSION, "templates/dispatch", path))).toBe(
				true,
			);
		expect(existsSync(join(EXTENSION, "templates/grill/SKILL.md"))).toBe(true);
	});

	it("/setup-dispatch is the go-ahead to write a new skill; only an existing one waits for a yes", () => {
		const shortcut = read("copilot/shortcuts/setup-dispatch.md");
		expect(shortcut).toStartWith(
			"---\nhint: write this project's dispatch skill\n---\n",
		);
		const line = shortcut.split("\n---\n")[1]?.trim() ?? "";
		expect(line).not.toContain("\n");
		expect(line).toContain("write .agents/skills/dispatch/");
		expect(SETUP).toContain(
			"write the files without asking, then show the content of each one",
		);
		expect(SETUP).toContain("If .agents/skills/dispatch/ already exists");
		expect(SETUP).toContain("show the diff");
		expect(SETUP).toContain("write nothing without an explicit yes");
	});
});

describe("setting up a dispatch skill", () => {
	it("writes only the skill and its link, and says where it lands", () => {
		expect(SETUP).toContain(
			"Write only under .agents/skills/dispatch/ in the project root",
		);
		expect(SETUP).not.toContain("GEMINI.md");
	});

	it("links Claude Code to the skill when the project has .claude/ or the human asks, and otherwise says how", () => {
		expect(SETUP).toContain(
			".claude/skills/dispatch pointing to ../../.agents/skills/dispatch",
		);
		expect(SETUP).toContain(".claude/ directory or the human asks");
		expect(SETUP).toContain("Create that link");
		expect(SETUP).toContain(
			"`ln -s ../../.agents/skills/dispatch .claude/skills/dispatch`",
		);
	});

	it("offers to move a real .claude/skills/dispatch/ and moves nothing without a yes", () => {
		expect(SETUP).toContain("When neither .agents/skills/dispatch/");
		expect(SETUP).toContain("real .claude/skills/dispatch/");
		expect(SETUP).toContain("go-ahead");
		expect(SETUP).toContain("offer to move it to .agents/skills/dispatch/");
		expect(SETUP).toContain("leave the link");
		expect(SETUP).toContain("move or write nothing without an explicit yes");
	});

	it("takes the stamp from `kabane dispatch stamp`, run as the host's block says, and the frontmatter takes it", () => {
		expect(SETUP).toContain("{{TEMPLATE_STAMP}}");
		expect(SETUP).toContain("kabane dispatch stamp");
		expect(SETUP).toContain("KABANE ON THIS MACHINE");
		expect(SETUP).toContain("copied exactly");
		expect(SETUP).toContain("never invent a stamp");
		const frontmatter = template("SKILL.md").split("\n---\n")[0];
		expect(frontmatter).toContain(
			"metadata:\n  kabane-template: {{TEMPLATE_STAMP}}",
		);
	});

	it("every placeholder in the skill is one PLACEHOLDERS.md says how to fill", () => {
		const documented = template("PLACEHOLDERS.md");
		const used = SKILL_FILES.flatMap((path) => [
			...template(path).matchAll(/\{\{[A-Z_]+\}\}/g),
		]).map(([placeholder]) => placeholder);
		expect(used.length).toBeGreaterThan(0);
		for (const placeholder of used) expect(documented).toContain(placeholder);
	});

	it("the template tracks work through kabane and nothing else", () => {
		const skill = template("SKILL.md");
		for (const tool of [
			"kabane_add",
			"kabane_link",
			"kabane_contextAdd",
			"kabane_done",
		])
			expect(skill).toContain(tool);
	});

	it("an issue's internal steps go in its checklist, under the checklist module's rule", () => {
		const prose = (path: string): string => flat(template(path));
		expect(prose("SKILL.md")).toContain(
			"An issue's internal steps go in its checklist, not in sub-issues",
		);
		expect(prose("references/issue-template.md")).toContain(
			"put its internal steps in its checklist with `kabane_checklistAdd`",
		);
		for (const path of ["SKILL.md", "references/issue-template.md"]) {
			expect(prose(path)).toContain("no assignee");
			expect(prose(path)).toContain("no state beyond done");
			expect(prose(path)).toContain("subtask");
		}
	});

	it("a wave's open decisions are asked on its parent and grilled by the grill skill, not by its own interview", () => {
		const skill = template("SKILL.md");
		expect(skill).toContain("wave's parent issue first");
		expect(skill).toContain("kabane_ask");
		expect(skill).toContain("(the grill skill, on the parent's id)");
		expect(skill).toContain("`kabane answer`, and stop there");
		expect(skill).toContain("Do not do this for inline or one-issue work");
		expect(skill).toContain("`questions.decisions` section");
		expect(skill).not.toMatch(/\brounds?\b|offer (to|a) grill/i);
		expect(template("references/issue-template.md")).toContain(
			"A question answered on the parent is the exception",
		);
	});
});

describe("grilling the human", () => {
	it("the shipped skill needs no filling", () => {
		expect(grill()).toStartWith("---\nname: grill\ndescription: ");
		expect(grill()).not.toContain("{{");
	});

	it("both read the questions, record through kabane_answer, and withdraw with a reason", () => {
		for (const text of [GRILLING, grill()]) {
			expect(text).toContain("kabane_questions");
			expect(text).toContain("kabane_answer");
			expect(text).toContain("withdraw: true");
			expect(text).toMatch(/one (question )?at a time/i);
		}
		expect(GRILLING).toContain("Say when an issue moves to next");
		expect(grill()).toContain("When its result says the issue moved to next");
		expect(grill()).toContain("nextCursor");
	});

	it("re-reads the issue before recording, because a handle can shift under sync", () => {
		expect(GRILLING).toContain("before recording");
		expect(GRILLING).toContain("re-read");
		expect(GRILLING).toContain("kabane_questions");
		expect(GRILLING).toContain("its id");
		expect(grill()).toContain(
			"re-read that issue (`kabane_questions` with its `id`)",
		);
		expect(grill()).toContain("same question text");
		expect(grill()).toContain("use the handle");
		expect(grill()).toContain("tell the human");
	});

	it("records the human's reply as relayed, so the decision is credited to them", () => {
		expect(GRILLING).toContain(
			"Record a choice with kabane_answer and relayed: true",
		);
		expect(GRILLING).toContain(
			"withdraw: true, relayed: true and their reason",
		);
		expect(grill()).toContain("answer and `relayed: true`");
		expect(grill()).toContain("`withdraw: true`, `relayed: true`");
	});

	it("reshapes a question the decision does not fit with replaces, never the nearest choice", () => {
		expect(GRILLING).toContain("never squeeze");
		expect(GRILLING).toContain("kabane_ask");
		expect(GRILLING).toContain("replaces");
		expect(GRILLING).toContain("handle");
		expect(grill()).toContain("do not squeeze");
		expect(grill()).toContain("kabane_ask");
		expect(grill()).toContain("replaces");
		expect(grill()).toContain("handle");
	});

	it("asks through the harness's choice prompt, with plain text only the fallback", () => {
		expect(GRILLING).toContain("harness's own choice prompt");
		expect(GRILLING).toContain("whenever it has one");
		expect(GRILLING).toContain("recommended one first");
		expect(grill()).toContain(
			"Ask it through the harness's choice prompt whenever it\n   offers one",
		);
	});

	it("never answers for the human, the recommendation included", () => {
		expect(GRILLING).toContain("Only the human answers");
		expect(GRILLING).toContain("never record an answer they did not give");
		expect(grill()).toContain(
			"Never record an answer they did not give, the recommended one included",
		);
	});

	it("installs into a project only on request, under the dispatch skill's rule", () => {
		expect(GRILLING).toContain("When they ask you to install");
		expect(GRILLING).toContain("copy SKILL.md unchanged");
		expect(GRILLING).toContain(".agents/skills/grill/SKILL.md");
		expect(GRILLING).toContain("when neither .agents/skills/grill/");
		expect(GRILLING).toContain("real .claude/skills/grill/");
		expect(GRILLING).toContain("request is the go-ahead");
		expect(GRILLING).toContain("real .claude/skills/grill/");
		expect(GRILLING).toContain("offer to move");
		expect(GRILLING).toContain("waits for a yes");
	});
});
