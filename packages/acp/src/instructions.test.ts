// The instructions are prose, so what is testable about them is the shape the board and the harness
// depend on: unique `/names`, single-line templates, and the two tool names the linking procedure
// is only correct if it names.
import { describe, expect, it } from "bun:test";
import { CopilotInstructions } from "./instructions";

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
		expect(CopilotInstructions.SKILLS).toContain("cabane_edit");
		expect(CopilotInstructions.SKILLS).toContain("cabane_upstream_link");
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
