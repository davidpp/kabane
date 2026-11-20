// The skills, copilot files and templates are prose, so what is testable about them is what a
// session and the projects it writes depend on: the paths they name exist in this directory, every
// placeholder is documented, the stamp comes from a command, and the tool names they are only
// correct if they name. The host fills `{{extension}}` and `{{kabane}}`; here the files are read
// as they ship.
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXTENSION = resolve(import.meta.dir, "..");
const read = (path: string): string =>
	readFileSync(join(EXTENSION, path), "utf8");
const body = (path: string): string => read(path).split("\n---\n")[1] ?? "";
const flat = (text: string): string => text.replace(/\s+/g, " ");

const SETUP_DIR = "skills/setup-dispatch";
const SETUP = body(`${SETUP_DIR}/SKILL.md`);
const OPTIONS = [
	"init",
	"refresh",
	"upstream",
	"goals",
	"harnesses",
	"research",
];
const option = (name: string): string =>
	read(`${SETUP_DIR}/references/${name}.md`);
const GRILLING = body("copilot/procedures/grilling.md");
const template = (path: string): string => read(`templates/dispatch/${path}`);
const grill = (): string => read("templates/grill/SKILL.md");

// What the copilot copies into a project, as opposed to PLACEHOLDERS.md, which it only reads.
const SKILL_FILES = [
	"SKILL.md",
	"references/issue-template.md",
	"references/agent-prompt.md",
	"references/specialists.md",
	"references/tags.md",
];

// The section of PLACEHOLDERS.md under a `## ` heading, up to the next one.
const placeholdersSection = (heading: string): string =>
	template("PLACEHOLDERS.md")
		.split(`\n## ${heading}\n`)[1]
		?.split("\n## ")[0] ?? "";
// The overlays PLACEHOLDERS.md names: copied only when a setup answer selects them.
const OVERLAYS = [
	...placeholdersSection("Overlays").matchAll(/`(references\/[^`]+\.md)`/g),
].map(([, path]) => path ?? "");

describe("the copilot files", () => {
	it("are the grilling procedure and the one shortcut, titled as the copilot reads them", () => {
		expect(readdirSync(join(EXTENSION, "copilot/procedures"))).toEqual([
			"grilling.md",
		]);
		expect(read("copilot/procedures/grilling.md")).toStartWith(
			"---\ntitle: GRILLING\n---\n",
		);
		expect(readdirSync(join(EXTENSION, "copilot/shortcuts"))).toEqual([
			"setup-dispatch.md",
		]);
	});

	it("/setup-dispatch runs the served setup-dispatch skill from its menu", () => {
		const shortcut = read("copilot/shortcuts/setup-dispatch.md");
		expect(shortcut).toStartWith(
			"---\nhint: write or refresh this project's dispatch skill\n---\n",
		);
		const line = shortcut.split("\n---\n")[1]?.trim() ?? "";
		expect(line).not.toContain("\n");
		expect(line).toContain("kabane_skillGet (name setup-dispatch)");
		expect(line).toContain("its menu");
	});
});

describe("the setup-dispatch skill", () => {
	it("is named for its directory, says when to use it, and stays under 500 lines", () => {
		const skill = read(`${SETUP_DIR}/SKILL.md`);
		expect(skill).toStartWith("---\nname: setup-dispatch\ndescription: ");
		expect(skill.split("\n").length).toBeLessThan(500);
	});

	it("routes each option to the one reference it ships", () => {
		expect(
			readdirSync(join(EXTENSION, SETUP_DIR, "references")).sort(),
		).toEqual(OPTIONS.map((name) => `${name}.md`).sort());
		for (const name of OPTIONS)
			expect(SETUP).toMatch(
				new RegExp(
					`\\| \`${name}\` \\|[^\\n]*\\[references/${name}\\.md\\]\\(references/${name}\\.md\\) \\|`,
				),
			);
		expect(SETUP).toContain("Read only the one the option needs");
	});

	it("with no option, leads its menu from what the project shows and never runs one unasked", () => {
		const routing = flat(SETUP.split("## Routing")[1]?.split("\n## ")[0] ?? "");
		expect(routing).toContain("Never run one before the human picks");
		expect(routing).toContain("lead with `init`");
		expect(routing).toContain("`{{kabane}} doctor --json`");
		expect(routing).toContain(
			"`dispatch-skill-behind` or `dispatch-skill-unstamped`: lead with `refresh`",
		);
	});

	it("a single question's option is a refresh that asks it again, or init on a project with no skill", () => {
		for (const name of ["upstream", "goals", "harnesses", "research"]) {
			const text = flat(option(name));
			expect(text).toContain("run [init.md](init.md)");
			expect(text).toContain("Follow [refresh.md](refresh.md)");
			expect(text).toContain("treat question");
			expect(text).toContain("Ask it with every choice PLACEHOLDERS.md lists");
		}
	});

	it("a refresh keeps the recorded answers, takes a fresh stamp and writes nothing without a yes", () => {
		const text = flat(option("refresh"));
		expect(text).toContain("Keep every answer `## This project` records");
		expect(text).toContain("never keep the old stamp");
		expect(text).toContain("Write nothing without an explicit yes");
	});

	it("names only paths this directory ships, through {{extension}}", () => {
		expect(SETUP).toContain("{{extension}}/templates/dispatch:");
		expect(GRILLING).toContain("{{extension}}/templates/grill/SKILL.md:");
		expect(SETUP).toContain("{{extension}}/templates/examples/");
		for (const path of [...SKILL_FILES, "PLACEHOLDERS.md"])
			expect(existsSync(join(EXTENSION, "templates/dispatch", path))).toBe(
				true,
			);
		expect(readdirSync(join(EXTENSION, "templates/examples")).sort()).toEqual([
			"goals-and-steward.md",
			"solo-on-main.md",
			"team-with-prs.md",
		]);
		expect(existsSync(join(EXTENSION, "templates/grill/SKILL.md"))).toBe(true);
	});

	it("init is the go-ahead to write a new skill; only an existing one waits for a yes", () => {
		expect(flat(option("init"))).toContain(
			"Being asked to set the skill up is the go-ahead",
		);
		expect(SETUP).toContain(
			"write the files without asking, then show the content of each one",
		);
		const existing = SETUP.split(/(?<=\.)\s+/).find((sentence) =>
			sentence.startsWith("If .agents/skills/dispatch/ already exists"),
		);
		expect(existing).toContain("show the diff");
		expect(existing).toContain("write nothing without an explicit yes");
	});

	it("offers every choice a question lists, as written, and never drops one", () => {
		const asking = flat(SETUP);
		expect(asking).toContain(
			"Offer every choice the question lists, as PLACEHOLDERS.md words it",
		);
		expect(asking).toContain("Never drop, merge or reword a choice");
		expect(placeholdersSection("Questions")).toContain(
			"none, GitHub Issues, or\n   Linear",
		);
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

	it("takes the stamp from `{{kabane}} dispatch stamp`, the kabane serving the skill, and the frontmatter takes it", () => {
		expect(SETUP).toContain("{{TEMPLATE_STAMP}}");
		expect(SETUP).toContain("`{{kabane}} dispatch stamp`");
		expect(SETUP).toContain("copied exactly");
		expect(SETUP).toContain("never invent a stamp");
		const frontmatter = template("SKILL.md").split("\n---\n")[0];
		expect(frontmatter).toContain(
			"metadata:\n  kabane-template: {{TEMPLATE_STAMP}}",
		);
	});

	it("every placeholder in the skill and its overlays is one PLACEHOLDERS.md says how to fill", () => {
		const documented = template("PLACEHOLDERS.md");
		const used = [...SKILL_FILES, ...OVERLAYS]
			.flatMap((path) => [...template(path).matchAll(/\{\{[A-Z_]+\}\}/g)])
			.map(([placeholder]) => placeholder);
		expect(used.length).toBeGreaterThan(0);
		for (const placeholder of used) expect(documented).toContain(placeholder);
	});

	it("every overlay PLACEHOLDERS.md names ships, and is not one of the files copied always", () => {
		expect(OVERLAYS).toEqual([
			"references/goals.md",
			"references/research.md",
			"references/cross-harness.md",
			"references/upstream.md",
		]);
		for (const overlay of OVERLAYS) {
			expect(existsSync(join(EXTENSION, "templates/dispatch", overlay))).toBe(
				true,
			);
			expect(SKILL_FILES).not.toContain(overlay);
		}
	});

	it("copies an overlay only when an answer selects it, and removes one a refresh no longer selects", () => {
		expect(SETUP).toContain(
			"except the overlays PLACEHOLDERS.md lists under ## Overlays, which are copied only when an answer selects them",
		);
		expect(SETUP).toContain("copy an overlay only when an answer selects it");
		expect(SETUP).toContain(
			"an overlay the answers no longer select is removed, which the diff shows",
		);
	});

	it("settles PLACEHOLDERS.md's questions from the files and asks the rest before writing, through the choice prompt", () => {
		expect(placeholdersSection("Questions")).not.toBe("");
		expect(SETUP).toContain(
			"Settle the questions under ## Questions in PLACEHOLDERS.md",
		);
		expect(SETUP).toContain(
			"Answer each one from the project's files where they settle it",
		);
		expect(SETUP).toContain("Write nothing until they are answered");
		// grilling.md's wording, so the copilot asks the same way in both procedures.
		const prompt =
			"through your harness's own choice prompt whenever it has one, each question's choices as its options and the recommended one first, and in plain text, ending your turn on it, only where it has none";
		expect(SETUP).toContain(prompt);
		expect(GRILLING).toContain(
			prompt.replace("each question's choices", "the choices"),
		);
		// The questions come after reading the project and before filling.
		const order = [
			"Read what the project says about itself",
			"## Questions",
			"Fill every placeholder",
		].map((step) => SETUP.indexOf(step));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(order[0]).toBeGreaterThanOrEqual(0);
	});

	it("records the answers in the skill's ## This project section and reads them back on a refresh", () => {
		expect(template("SKILL.md")).toContain(
			"## This project\n\n{{SETUP_ANSWERS}}",
		);
		expect(template("PLACEHOLDERS.md")).toContain("`{{SETUP_ANSWERS}}`");
		expect(SETUP).toContain(
			"The answers fill {{SETUP_ANSWERS}}, each with its source",
		);
		expect(SETUP).toContain(
			"read its ## This project section first and keep every answer it records",
		);
		expect(SETUP).toContain(
			"each answer and whether the project's files or the human gave it",
		);
	});

	it("the questions are not the go-ahead: the permission rule still decides", () => {
		expect(SETUP).toContain(
			"The answers are about the project, not permission to write",
		);
		expect(SETUP).toContain("the write rule below still decides");
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
			expect(prose(path)).toContain("if it needs any of those, it's a subtask");
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
		expect(GRILLING).toContain("before recording, re-read that issue");
		expect(GRILLING).toContain("with kabane_questions and its id");
		expect(grill()).toContain(
			"re-read that issue (`kabane_questions` with its `id`)",
		);
		expect(grill()).toContain("same question text");
		expect(grill()).toContain("use the handle that does");
		expect(grill()).toContain("tell the human what moved");
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
		expect(GRILLING).toContain("replaces set to its handle");
		expect(grill()).toContain("do not squeeze");
		expect(grill()).toContain("kabane_ask");
		expect(grill()).toContain("`replaces` set to its handle");
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
