// The instructions are prose, so what is testable about them is the shape the board and the harness
// depend on: unique `/names`, single-line templates, the tool names a procedure is only correct if
// it names, and the dispatch and grill templates where the skill text says they are.
import { describe, expect, it } from "bun:test";
import {
	existsSync,
	readFileSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotInstructions as HarnessInstructions } from "@cabane/acp";
import { Templates } from "@cabane/acp/templates";
import { type Result } from "@cabane/core";
import { CopilotInstructions } from "./copilot-instructions";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const template = (path: string): string =>
	readFileSync(join(HarnessInstructions.DISPATCH_TEMPLATE, path), "utf8");

// What the copilot copies into a project, as opposed to PLACEHOLDERS.md, which it only reads.
const SKILL_FILES = [
	"SKILL.md",
	"references/issue-template.md",
	"references/agent-prompt.md",
	"references/specialists.md",
];

// Word for word what @cabane/checklist's MCP instructions say, which its tools test pins.
const ITEM_OR_SUBTASK =
	"An item has no assignee, no state beyond done, and no brief; if it needs any of those, it's a subtask.";

const SETUP: CopilotInstructions.Setup = {
	configPath: "/sandbox/home/config.json",
	extensions: [],
	procedures: [],
	shortcuts: [],
};
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

	it("offers settings, which reads before anything is changed", () => {
		const settings = CopilotInstructions.SHORTCUTS.find(
			(s) => s.name === "settings",
		);
		expect(settings?.template).toContain("kabane_configGet");
		expect(settings?.template).toContain("wait for me");
	});

	it("offers setup-dispatch", () => {
		const names = CopilotInstructions.SHORTCUTS.map((s) => s.name);
		expect(names).toContain("setup-dispatch");
	});

	it("offers doctor, which hands the pass to the doctor procedure", () => {
		const doctor = CopilotInstructions.SHORTCUTS.find(
			(s) => s.name === "doctor",
		);
		expect(doctor?.hint).toBe("check what kabane wrote is current");
		expect(doctor?.template).toContain("kabane doctor");
		expect(doctor?.template).not.toContain("\n");
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
		expect(CopilotInstructions.SKILLS).toContain("layer: local");
		expect(CopilotInstructions.SKILLS).toContain("Never pass layer: shared");
		expect(CopilotInstructions.SKILLS).not.toContain("supplies the rest");
	});

	it("tells the human which layer still decides when a write comes back shadowed", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"When kabane_configSet returns shadowedBy",
		);
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

	it("names the resolved config path and the installed extensions", () => {
		const prompt = CopilotInstructions.systemPrompt(
			{ ...SETUP, extensions: ["notes", "timer"] },
			BIN,
		);
		expect(prompt).toContain("/sandbox/home/config.json");
		expect(prompt).toContain(
			"Installed extensions: notes, timer. These are the extensions available to enable.",
		);
		expect(prompt).not.toContain("~/.kabane");
		expect(CopilotInstructions.systemPrompt(SETUP, BIN)).toContain(
			"Installed extensions: none.",
		);
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

	it("/split puts steps on a checklist and deliverables in subtasks, under the checklist module's rule", () => {
		const split = CopilotInstructions.SHORTCUTS.find((s) => s.name === "split");
		expect(split?.template).toContain(
			"put the steps of one change on its checklist with kabane_checklistAdd",
		);
		expect(split?.template).toContain(
			"create each separate deliverable as a subtask under it",
		);
		expect(split?.template).toContain(ITEM_OR_SUBTASK);
	});
});

describe("CopilotInstructions setting up a dispatch skill", () => {
	it("the block allows the procedures' writes and the skill names where it lands", () => {
		expect(CopilotInstructions.BLOCK).toContain(
			"you may write the files the procedures below name and nowhere else",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"Write only under .agents/skills/dispatch/ in the project root",
		);
		expect(CopilotInstructions.SKILLS).not.toContain("GEMINI.md");
	});

	it("links Claude Code to the skill when the project has .claude/ or the human asks, and otherwise says how", () => {
		const { SKILLS } = CopilotInstructions;
		expect(SKILLS).toContain(
			".claude/skills/dispatch pointing to ../../.agents/skills/dispatch",
		);
		expect(SKILLS).toContain(
			"Create that link when the project root already has a .claude/ directory or the human asks for it",
		);
		expect(SKILLS).toContain(
			"`ln -s ../../.agents/skills/dispatch .claude/skills/dispatch`",
		);
	});

	it("offers to move a real .claude/skills/dispatch/ and moves nothing without a yes", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"When neither .agents/skills/dispatch/ nor a real .claude/skills/dispatch/ directory exists yet, being asked to set the skill up is the go-ahead",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"offer to move it to .agents/skills/dispatch/ and leave the link in its place, show the diff against what you would write, and move or write nothing without an explicit yes",
		);
	});

	it("the skill text points at the template this package ships", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			HarnessInstructions.DISPATCH_TEMPLATE,
		);
		for (const path of [...SKILL_FILES, "PLACEHOLDERS.md"])
			expect(
				existsSync(join(HarnessInstructions.DISPATCH_TEMPLATE, path)),
			).toBe(true);
	});

	it("the system prompt gives the dispatch template's stamp, and the skill's frontmatter takes it", () => {
		const prompt = CopilotInstructions.systemPrompt(SETUP, BIN);
		const stamp = unwrap(Templates.stamp("dispatch"));
		expect(stamp).toMatch(/^dispatch@[0-9a-f]{12}$/);
		expect(prompt).toContain(`DISPATCH TEMPLATE STAMP: ${stamp}`);
		expect(CopilotInstructions.SKILLS).toContain(
			"{{TEMPLATE_STAMP}} takes the DISPATCH TEMPLATE STAMP given below, copied exactly",
		);
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

	it("doctor reads the report once, fixes only auto findings unasked and never the MCP entries", () => {
		const skills = CopilotInstructions.SKILLS;
		expect(skills).toContain("run `kabane doctor --json` once");
		expect(skills).toContain(
			"Run `kabane doctor --fix` once, without asking first",
		);
		expect(skills).toContain(
			"Run `kabane doctor --fix <source>/<id>` only after an explicit yes",
		);
		expect(skills).toContain(
			"Never run the fix of a kabane/mcp-entry-stale-<harness> finding",
		);
		expect(skills).toContain(
			"never run a fix as a side effect of another request",
		);
		// A route to /setup-dispatch keeps that procedure's diff-and-yes rule.
		expect(skills).toContain("offer to run SETTING UP A DISPATCH SKILL");
	});

	it("/setup-dispatch is the go-ahead to write a new skill; only an existing one waits for a yes", () => {
		const shortcut = CopilotInstructions.SHORTCUTS.find(
			(s) => s.name === "setup-dispatch",
		);
		expect(shortcut?.template).toContain("write .agents/skills/dispatch/");
		expect(shortcut?.template).not.toMatch(/confirm|propose|before writing/i);
		expect(CopilotInstructions.BLOCK).toContain(
			"A shortcut or a direct instruction is the go-ahead for exactly what it asks",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"write the files without asking, then show the content of each one",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"If .agents/skills/dispatch/ already exists, show the diff and write nothing without an explicit yes",
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

	it("an issue's internal steps go in its checklist, under the checklist module's rule", () => {
		const prose = (path: string): string => template(path).replace(/\s+/g, " ");
		expect(prose("SKILL.md")).toContain(
			"An issue's internal steps go in its checklist, not in sub-issues",
		);
		expect(prose("references/issue-template.md")).toContain(
			"put its internal steps in its checklist with `kabane_checklistAdd`",
		);
		for (const path of ["SKILL.md", "references/issue-template.md"])
			expect(prose(path)).toContain(ITEM_OR_SUBTASK);
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
		readFileSync(join(HarnessInstructions.GRILL_TEMPLATE, "SKILL.md"), "utf8");

	it("the procedure points at the skill this package ships, which needs no filling", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			`${HarnessInstructions.GRILL_TEMPLATE}/SKILL.md`,
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

	it("records the human's reply as relayed, so the decision is credited to them", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"Record a choice with kabane_answer and relayed: true",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"withdraw: true, relayed: true and their reason",
		);
		expect(skill()).toContain("answer and `relayed: true`");
		expect(skill()).toContain("`withdraw: true`, `relayed: true`");
	});

	it("reshapes a question the decision does not fit with replaces, never the nearest choice", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"never squeeze it into the nearest one: reshape the question with kabane_ask and replaces set to its handle",
		);
		expect(skill()).toContain(
			"do not squeeze it into the nearest\n  choice. Reshape the question with `kabane_ask` and `replaces` set to its handle",
		);
	});

	it("asks through the harness's choice prompt, with plain text only the fallback", () => {
		expect(CopilotInstructions.SKILLS).toContain(
			"through your harness's own choice prompt whenever it has one, the choices as its options and the recommended one first",
		);
		expect(skill()).toContain(
			"Ask it through the harness's choice prompt whenever it\n   offers one",
		);
		expect(skill()).not.toContain("you may use it");
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
			"When they ask you to install it in this project, copy SKILL.md unchanged to .agents/skills/grill/SKILL.md",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"when neither .agents/skills/grill/ nor a real .claude/skills/grill/ directory exists, the request is the go-ahead",
		);
		expect(CopilotInstructions.SKILLS).toContain(
			"a real .claude/skills/grill/ directory gets the offer to move it and waits for a yes",
		);
	});
});

describe("CopilotInstructions with no extension", () => {
	it("names no extension: no loop, no run form, no official extension", () => {
		// "tool loop" is the kabane MCP server's own loop, not the extension.
		const prompt = CopilotInstructions.systemPrompt(SETUP, BIN).replaceAll(
			"tool loop",
			"",
		);
		expect(prompt).not.toMatch(/\bloop\b/i);
		expect(prompt).not.toMatch(/run form/i);
		expect(prompt).not.toMatch(/official extension/i);
		expect(prompt).not.toContain("EXTENSION ");
	});

	it("enables an installed extension by keeping the list, passing it whole and reopening the board", () => {
		const { SKILLS } = CopilotInstructions;
		expect(SKILLS).toContain(
			"To enable an installed extension, check the installed extensions KABANE ON THIS MACHINE lists below",
		);
		expect(SKILLS).toContain("preserve every existing entry in the new list");
		expect(SKILLS).toContain(
			"Pass the full comma-separated list to kabane_configSet with key extensions",
		);
		expect(SKILLS).toContain("remind the human to reopen the board");
	});
});

describe("CopilotInstructions running kabane", () => {
	it("runs kabane as the board's own bin, not one found on PATH", () => {
		const setup = CopilotInstructions.setup(SETUP, BIN);
		expect(setup).toContain(`This board runs kabane as \`'${BIN}'\``);
		expect(setup).toContain(`for example \`'${BIN}' --help\``);
		expect(setup).toContain("never as a kabane found on PATH");
	});

	it("quotes a bin the shell would split or expand", () => {
		expect(
			CopilotInstructions.setup(SETUP, "/Users/me/My Code/index.ts"),
		).toContain("`'/Users/me/My Code/index.ts' --help`");
		expect(
			CopilotInstructions.setup(SETUP, "/Users/me/it's $HOME/index.ts"),
		).toContain(`\`'/Users/me/it'\\''s $HOME/index.ts' --help\``);
	});

	it("quotes a bin the shell would read as a keyword or an assignment", () => {
		expect(CopilotInstructions.setup(SETUP, "if")).toContain("`'if' --help`");
		expect(CopilotInstructions.setup(SETUP, "KABANE_BIN=x")).toContain(
			"`'KABANE_BIN=x' --help`",
		);
	});
});

describe("CopilotInstructions with contributed procedures and shortcuts", () => {
	const contributed: CopilotInstructions.Setup = {
		...SETUP,
		extensions: ["notes", "timer", "quiet"],
		procedures: [
			{
				extension: "notes",
				procedures: [
					{
						title: "KEEPING NOTES",
						body: "Write notes with the notes command.",
					},
					{ title: "READING NOTES", body: "Read them back." },
				],
			},
			{ extension: "quiet", procedures: [] },
			{
				extension: "timer",
				procedures: [{ title: "TIMING", body: "Start the timer." }],
			},
		],
		shortcuts: [
			{ name: "note", hint: "write a note", template: "Write a note." },
			{ name: "triage", hint: "not the built-in", template: "Something else." },
		],
	};

	it("appends each extension's procedures after base kabane's whole text, under one heading naming it", () => {
		const prompt = CopilotInstructions.systemPrompt(contributed, BIN);
		const base = CopilotInstructions.systemPrompt(SETUP, BIN).replace(
			"Installed extensions: none.",
			"Installed extensions: notes, timer, quiet.",
		);
		expect(prompt.startsWith(`${base}\n\n`)).toBe(true);
		const added = prompt.slice(base.length + 2);
		expect(added).toBe(
			[
				"EXTENSION notes. These procedures come from the notes extension and add to kabane's own above.",
				"KEEPING NOTES. Write notes with the notes command.",
				"READING NOTES. Read them back.",
				"EXTENSION timer. These procedures come from the timer extension and add to kabane's own above.",
				"TIMING. Start the timer.",
			].join("\n\n"),
		);
		expect(prompt).not.toContain("EXTENSION quiet");
	});

	it("offers built-ins first, then contributed shortcuts, and a built-in name stays the built-in's", () => {
		const shortcuts = CopilotInstructions.shortcuts(contributed);
		expect(shortcuts).toEqual([
			...CopilotInstructions.SHORTCUTS,
			{ name: "note", hint: "write a note", template: "Write a note." },
		]);
	});
});

it("a compiled prompt still supplies procedures when shipped templates are missing", () => {
	const root = mkdtempSync(join(tmpdir(), "kabane-prompt-"));
	try {
		const entry = join(root, "prompt.ts");
		const binary = join(root, "prompt");
		writeFileSync(
			entry,
			`import { CopilotInstructions } from ${JSON.stringify(join(import.meta.dir, "copilot-instructions.ts"))}; console.log(CopilotInstructions.systemPrompt({configPath: "config.json", extensions: [], procedures: [], shortcuts: []}, "kabane"));`,
		);
		const build = Bun.spawnSync([
			process.execPath,
			"build",
			"--compile",
			entry,
			"--outfile",
			binary,
		]);
		expect(build.exitCode).toBe(0);
		const run = Bun.spawnSync([binary]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.toString()).toContain("SETTING UP A DISPATCH SKILL");
		expect(run.stdout.toString()).toContain("DOCTOR.");
		expect(run.stdout.toString()).toContain(
			"DISPATCH TEMPLATE STAMP: unavailable",
		);
		expect(run.stdout.toString()).toContain("never invent a stamp");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
