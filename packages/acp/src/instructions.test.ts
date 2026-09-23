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
	it("names the tool the substance goes through and the tool the link goes through", () => {
		expect(CopilotInstructions.SKILLS).toContain("kabane_edit");
		expect(CopilotInstructions.SKILLS).toContain("kabane_upstream_link");
	});

	it("rides along with the identity block in the one prompt harnesses are sent", () => {
		expect(CopilotInstructions.SYSTEM_PROMPT).toContain(
			CopilotInstructions.BLOCK,
		);
		expect(CopilotInstructions.SYSTEM_PROMPT).toContain(
			CopilotInstructions.SKILLS,
		);
	});
});

describe("CopilotInstructions setting up a dispatch skill", () => {
	it("the block allows the one write and names where it lands", () => {
		expect(CopilotInstructions.BLOCK).toContain(".claude/skills/dispatch/");
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
