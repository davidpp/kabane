// The instructions are prose, so what is testable about them is the shape the board and the harness
// depend on: unique `/names`, single-line templates, the tool names a procedure is only correct if
// it names, and the dispatch and grill templates where the skill text says they are.
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotInstructions } from "./instructions";

const template = (path: string): string =>
	readFileSync(join(CopilotInstructions.DISPATCH_TEMPLATE, path), "utf8");

// What the copilot copies into a project, as opposed to PLACEHOLDERS.md, which it only reads.
const SKILL_FILES = [
	"SKILL.md",
	"references/issue-template.md",
	"references/agent-prompt.md",
	"references/specialists.md",
];

const SETUP = { configPath: "/sandbox/home/config.json", extensions: ["loop"] };
const BIN = "/sandbox/checkout/packages/cli/index.ts";

describe("CopilotInstructions.SHORTCUTS", () => {
	it("every name is unique — the `/` palette resolves on it", () => {
		const names = CopilotInstructions.SHORTCUTS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("offers linear and github", () => {
		const names = CopilotInstructions.SHORTCUTS.map((s) => s.name);
		expect(names).toContain("linear");
		expect(names).toContain("github");
	});

	it("offers setup", () => {
		const names = CopilotInstructions.SHORTCUTS.map((s) => s.name);
		expect(names).toContain("setup");
	});

	it("offers setup-dispatch", () => {
		const names = CopilotInstructions.SHORTCUTS.map((s) => s.name);
		expect(names).toContain("setup-dispatch");
	});

	it("every template is one line, because it lands in the input line", () => {
		for (const shortcut of CopilotInstructions.SHORTCUTS) {
			expect(shortcut.name).not.toBe("");
			expect(shortcut.hint).not.toBe("");
			expect(shortcut.template).not.toContain("\n");
		}
	});
});

describe("CopilotInstructions.SKILLS", () => {
	it("names the config tools used to discover and change settings", () => {
		expect(CopilotInstructions.SKILLS).toContain("kabane_configGet");
		expect(CopilotInstructions.SKILLS).toContain("kabane_configSet");
	});

	it("writes the human's settings for a project to their scope, never to the checked-in file", () => {
		expect(CopilotInstructions.SKILLS).toContain("layer: scope");
		expect(CopilotInstructions.SKILLS).toContain("Never pass layer: project");
		expect(CopilotInstructions.SKILLS).not.toContain("supplies the rest");
	});

	it("names the tool the substance goes through and the tool the link goes through", () => {
		expect(CopilotInstructions.SKILLS).toContain("kabane_edit");
		expect(CopilotInstructions.SKILLS).toContain("kabane_upstream_link");
	});

	it("rides along with the identity block in the one prompt harnesses are sent", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP, BIN);
		expect(prompt).toContain(CopilotInstructions.BLOCK);
		expect(prompt).toContain(CopilotInstructions.SKILLS);
	});

	it("a config change the human named is applied; one the copilot suggests waits for a yes", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"When the human names the setting and its value",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"When the change is your own suggestion",
		);
		const setup = CopilotInstructions.SHORTCUTS.find((s) => s.name === "setup");
		expect(setup?.template).not.toMatch(/confirm/i);
	});

	it("names the resolved config path and the extensions this build ships", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP, BIN);
		expect(prompt).toContain("/sandbox/home/config.json");
		expect(prompt).toContain("This build ships: loop.");
		expect(prompt).not.toContain("~/.kabane");
	});
});

describe("CopilotInstructions reading the project", () => {
	it("reading the project is in scope; writing stays the tracker and the procedures' files", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP, BIN);
		expect(prompt).toContain("reading it is part of the job");
		expect(prompt).toContain("name the real files, functions and commands");
		expect(prompt).toContain(
			"Reading the project does not make it yours to change",
		);
		expect(prompt).toContain("not changing the code the issues describe");
	});

	it("/refine and /split ground the brief in the code", () => {
		for (const name of ["refine", "split"]) {
			const shortcut = CopilotInstructions.SHORTCUTS.find(
				(s) => s.name === name,
			);
			expect(shortcut?.template).toContain("read the code it concerns");
			expect(shortcut?.template).toContain("files");
			expect(shortcut?.template).toContain("verify");
		}
	});
});

describe("CopilotInstructions setting up a dispatch skill", () => {
	it("the block allows the procedures' writes and the skill names where it lands", () => {
		expect(CopilotInstructions.BLOCK).toContain(
			"you may write the files the procedures below name and nowhere else",
		);
		expect(CopilotInstructions.SKILLS).toContain(".claude/skills/dispatch/");
	});

	it("the skill text points at the template this package ships", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			CopilotInstructions.DISPATCH_TEMPLATE,
		);
		for (const path of [...SKILL_FILES, "PLACEHOLDERS.md"])
			expect(
				existsSync(join(CopilotInstructions.DISPATCH_TEMPLATE, path)),
			).toBe(true);
	});

	it("every placeholder in the skill is one PLACEHOLDERS.md says how to fill", () => {
		const documented = template("PLACEHOLDERS.md");
		const used = SKILL_FILES.flatMap((path) => [
			...template(path).matchAll(/\{\{[A-Z_]+\}\}/g),
		]).map(([placeholder]) => placeholder);
		expect(used.length).toBeGreaterThan(0);
		for (const placeholder of used) expect(documented).toContain(placeholder);
	});

	it("/setup-dispatch is the go-ahead to write a new skill; only an existing one waits for a yes", () => {
		const shortcut = CopilotInstructions.SHORTCUTS.find(
			(s) => s.name === "setup-dispatch",
		);
		expect(shortcut?.template).toContain("write .claude/skills/dispatch/");
		expect(shortcut?.template).not.toMatch(/confirm|propose|before writing/i);
		expect(CopilotInstructions.BLOCK).toContain(
			"A shortcut or a direct instruction is the go-ahead for exactly what it asks",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"write the files without asking, then show the content of each one",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"If it already exists, show the diff and write nothing without an explicit yes",
		);
		expect(CopilotInstructions.SKILLS).not.toContain("before writing it");
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
		for (const path of SKILL_FILES)
			expect(template(path).toLowerCase()).not.toContain("jake");
	});

	it("a wave's open decisions are asked on its parent and grilled by the grill skill, not by its own interview", () => {
		const skill = template("SKILL.md");
		expect(skill).toContain(
			"file the wave's parent issue first and ask those\ndecisions on it the same way, with `kabane_ask`",
		);
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

describe("CopilotInstructions grilling the human", () => {
	const skill = (): string =>
		readFileSync(join(CopilotInstructions.GRILL_TEMPLATE, "SKILL.md"), "utf8");

	it("the procedure points at the skill this package ships, which needs no filling", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			`${CopilotInstructions.GRILL_TEMPLATE}/SKILL.md`,
		);
		expect(skill()).toStartWith("---\nname: grill\ndescription: ");
		expect(skill()).not.toContain("{{");
		expect(skill().toLowerCase()).not.toContain("jake");
	});

	it("both read the questions, record through kabane_answer, and withdraw with a reason", () => {
		for (const text of [CopilotInstructions.SKILLS, skill()]) {
			expect(text).toContain("kabane_questions");
			expect(text).toContain("kabane_answer");
			expect(text).toContain("withdraw: true");
			expect(text).toMatch(/one (question )?at a time/i);
		}
		expect(CopilotInstructions.SKILLS).toContain(
			"Say when an issue moves to next",
		);
		expect(skill()).toContain("When its result says the issue moved to next");
		expect(skill()).toContain("nextCursor");
	});

	it("re-reads the issue before recording, because a handle can shift under sync", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"Just before recording, re-read that issue with kabane_questions and its id",
		);
		expect(skill()).toContain(
			"re-read that issue (`kabane_questions` with its `id`)",
		);
		expect(skill()).toContain(
			"same question text, use the handle that does and tell the human what moved",
		);
	});

	it("never answers for the human, the recommendation included", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"Only the human answers: never record an answer they did not give, the recommended one included",
		);
		expect(skill()).toContain(
			"Never record an answer they did not give, the recommended one included",
		);
	});

	it("installs into a project only on request, under the dispatch skill's rule", () => {
		expect(CopilotInstructions.BLOCK).toContain(
			"For a project's dispatch or grill skill, you may write the files the procedures below name",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"When they ask you to install it in this project, copy SKILL.md unchanged to .claude/skills/grill/SKILL.md",
		);
	});
});

describe("CopilotInstructions starting a loop run", () => {
	it("starts one through the loop's own command, on an instruction, and waits for a yes on its own idea", () => {
		const { SKILLS } = CopilotInstructions;
		expect(SKILLS).toContain("`kabane loop start <id>`");
		expect(SKILLS).toContain(
			'When the human tells you to run an issue ("run JCAB-79 with codex"), that is the go-ahead',
		);
		expect(SKILLS).toContain(
			"When a run is your own suggestion, name the issue and the harness and wait for a yes",
		);
	});

	it("runs kabane as the board's own bin, not one found on PATH", () => {
		const setup = CopilotInstructions.setup(SETUP, BIN);
		expect(setup).toContain(`This board runs kabane as \`'${BIN}'\``);
		expect(setup).toContain(`\`'${BIN}' loop start <id>\``);
		expect(setup).toContain("never as a kabane found on PATH");
		expect(CopilotInstructions.SKILLS).toContain(
			"as the kabane command KABANE ON THIS MACHINE names",
		);
	});

	it("quotes a bin the shell would split or expand", () => {
		expect(
			CopilotInstructions.setup(SETUP, "/Users/me/My Code/index.ts"),
		).toContain("`'/Users/me/My Code/index.ts' loop start <id>`");
		expect(
			CopilotInstructions.setup(SETUP, "/Users/me/it's $HOME/index.ts"),
		).toContain(`\`'/Users/me/it'\\''s $HOME/index.ts' loop start <id>\``);
	});

	it("quotes a bin the shell would read as a keyword or an assignment", () => {
		expect(CopilotInstructions.setup(SETUP, "if")).toContain(
			"`'if' loop start <id>`",
		);
		expect(CopilotInstructions.setup(SETUP, "KABANE_BIN=x")).toContain(
			"`'KABANE_BIN=x' loop start <id>`",
		);
	});

	it("says a single issue runs too, and that `a` opens the run form on any issue", () => {
		const { SKILLS } = CopilotInstructions;
		expect(SKILLS).toContain(
			"loop drives an issue, or a parent issue's subtasks, to done",
		);
		expect(SKILLS).toContain("`a` on an issue opens its run form");
		expect(SKILLS).not.toContain("on a parent with subtasks");
	});

	it("reports the run id and how to stop the run", () => {
		expect(CopilotInstructions.SKILLS).toContain("report the run id");
		expect(CopilotInstructions.SKILLS).toContain("`kabane loop stop <runId>`");
	});
});
