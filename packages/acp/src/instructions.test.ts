// The instructions are prose, so what is testable about them is the shape the board and the harness
// depend on: unique `/names`, single-line templates, the tool names a procedure is only correct if
// it names, and a dispatch template that is where the skill text says it is and fillable from it.
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

	it("names the tool the substance goes through and the tool the link goes through", () => {
		expect(CopilotInstructions.SKILLS).toContain("kabane_edit");
		expect(CopilotInstructions.SKILLS).toContain("kabane_upstream_link");
	});

	it("rides along with the identity block in the one prompt harnesses are sent", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP);
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
		const prompt = CopilotInstructions.systemPrompt(SETUP);
		expect(prompt).toContain("/sandbox/home/config.json");
		expect(prompt).toContain("This build ships: loop.");
		expect(prompt).not.toContain("~/.kabane");
	});
});

describe("CopilotInstructions reading the project", () => {
	it("reading the project is in scope; writing stays the tracker and the procedures' files", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP);
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
});
