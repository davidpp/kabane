// Real extension directories on disk, read by the real reader and, at the end, loaded through the
// real loader into the board's real copilot and announcer.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CopilotInstructions } from "@cabane/board/copilot-instructions";
import { parseArgs } from "@cabane/extension";
import { boardDeps } from "./commands/board-runtime";
import { configPath } from "./config";
import { openContext } from "./context";
import { CopilotFiles } from "./copilot-files";
import { Extensions } from "./extensions";

const ROOT = join(tmpdir(), `kabane-copilot-files-${crypto.randomUUID()}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const LOOP = resolve(import.meta.dir, "../../../extensions/loop");

/** An extension directory holding `files`, by path under it. */
const extension = (
	name: string,
	files: Record<string, string>,
	parent = join(ROOT, crypto.randomUUID()),
): Extensions.Directory => {
	const directory = join(parent, name);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), text);
	}
	return { name, directory };
};

const procedure = (title: string, body: string): string =>
	`---\ntitle: ${title}\n---\n${body}\n`;
const shortcut = (hint: string, body: string): string =>
	`---\nhint: ${hint}\n---\n${body}\n`;

describe("CopilotFiles.read", () => {
	it("reads procedures and shortcuts by file name, filling {{extension}} with the directory", () => {
		const notes = extension("notes", {
			"copilot/procedures/b-reading.md": procedure(
				"READING NOTES",
				"Read {{extension}}/notes.md.",
			),
			"copilot/procedures/a-keeping.md": procedure(
				"KEEPING NOTES",
				"Keep them.\n\nTwo paragraphs.",
			),
			"copilot/procedures/ignored.txt": "not markdown",
			"copilot/shortcuts/note.md": shortcut(
				"write a note",
				"Write a note in {{extension}}.",
			),
		});
		const read = CopilotFiles.read([notes]);
		expect(read.refused).toEqual([]);
		expect(read.procedures).toEqual([
			{
				extension: "notes",
				procedures: [
					{ title: "KEEPING NOTES", body: "Keep them.\n\nTwo paragraphs." },
					{
						title: "READING NOTES",
						body: `Read ${notes.directory}/notes.md.`,
					},
				],
			},
		]);
		expect(read.shortcuts).toEqual([
			{
				name: "note",
				hint: "write a note",
				template: `Write a note in ${notes.directory}.`,
			},
		]);
	});

	it("fills {{extension}} with the path as it is, `$&` and `$$` included, in titles too", () => {
		const odd = extension(
			"odd",
			{
				"copilot/procedures/odd.md": procedure(
					"FROM {{extension}}",
					"Run {{extension}}/bin.",
				),
			},
			join(ROOT, "e10$&x", "a$$b"),
		);
		expect(odd.directory).toContain("e10$&x/a$$b/odd");
		const read = CopilotFiles.read([odd]);
		expect(read.procedures).toEqual([
			{
				extension: "odd",
				procedures: [
					{
						title: `FROM ${odd.directory}`,
						body: `Run ${odd.directory}/bin.`,
					},
				],
			},
		]);
	});

	it("an extension without copilot files contributes nothing", () => {
		const read = CopilotFiles.read([extension("bare", { "index.ts": "" })]);
		expect(read).toEqual({ procedures: [], shortcuts: [], refused: [] });
	});

	it("refuses each unusable file with one line naming the extension and the file, and loads the rest", () => {
		const bad = extension("bad", {
			"copilot/procedures/bare.md": "No frontmatter here.\n",
			"copilot/procedures/unclosed.md": "---\ntitle: OPEN\nNo close.\n",
			"copilot/procedures/yaml.md": "---\ntitle: [unclosed\n---\nBody.\n",
			"copilot/procedures/untitled.md": "---\n---\nBody.\n",
			"copilot/procedures/policy.md":
				"---\ntitle: POLICY\nmode: bypassPermissions\n---\nBody.\n",
			"copilot/procedures/good.md": procedure("GOOD", "Still loads."),
			"copilot/shortcuts/long.md": shortcut("two lines", "One.\nTwo."),
			"copilot/shortcuts/empty.md": shortcut("nothing", ""),
			"copilot/shortcuts/hintless.md": "---\ntitle: wrong key\n---\nGo.\n",
			"copilot/shortcuts/triage.md": shortcut("mine", "Triage my way."),
			"copilot/shortcuts/fine.md": shortcut("fine", "Do the fine thing."),
		});
		const read = CopilotFiles.read([bad]);
		expect(read.procedures).toEqual([
			{
				extension: "bad",
				procedures: [{ title: "GOOD", body: "Still loads." }],
			},
		]);
		expect(read.shortcuts.map((s) => s.name)).toEqual(["fine"]);
		const lines = read.refused.map(Extensions.line);
		expect(lines).toEqual([
			"Extension bad: copilot/procedures/bare.md has no frontmatter between --- lines; add one",
			"Extension bad: copilot/procedures/policy.md: invalid frontmatter (Unrecognized key(s) in object: 'mode')",
			"Extension bad: copilot/procedures/unclosed.md has no frontmatter between --- lines; add one",
			"Extension bad: copilot/procedures/untitled.md: invalid frontmatter (Expected object, received null)",
			"Extension bad: copilot/procedures/yaml.md: its frontmatter is not YAML",
			"Extension bad: copilot/shortcuts/empty.md: its body must be one line, the template dropped into the prompt",
			"Extension bad: copilot/shortcuts/hintless.md: invalid frontmatter (hint: Required)",
			"Extension bad: copilot/shortcuts/long.md: its body must be one line, the template dropped into the prompt",
			"Extension bad: copilot/shortcuts/triage.md: /triage is a built-in shortcut, which wins; rename the file",
		]);
	});

	it("refuses a copilot directory that is a file, a nameless file, an empty body, a long title, an oversized file and base kabane's headings", () => {
		const edges = extension("edges", {
			"copilot/shortcuts": "a file where a directory belongs",
			"copilot/procedures/.md": procedure("NAMELESS", "Body."),
			"copilot/procedures/empty.md": procedure("EMPTY", ""),
			"copilot/procedures/two-lines.md":
				"---\ntitle: |\n  TWO\n  LINES\n---\nBody.\n",
			"copilot/procedures/huge.md": procedure("HUGE", "x".repeat(17 * 1024)),
			"copilot/procedures/doctor.md": procedure("DOCTOR", "Pretend."),
			"copilot/procedures/config.md": procedure("Config and help", "Pretend."),
			"copilot/procedures/windows.md":
				"\uFEFF---\r\ntitle: WINDOWS\r\n---\r\nLine one.\r\nLine two.\r\n",
		});
		const read = CopilotFiles.read([edges]);
		expect(read.procedures).toEqual([
			{
				extension: "edges",
				procedures: [{ title: "WINDOWS", body: "Line one.\nLine two." }],
			},
		]);
		expect(read.refused.map(Extensions.line)).toEqual([
			"Extension edges: copilot/procedures/.md has no name; name it <name>.md",
			"Extension edges: copilot/procedures/config.md: the title Config and help is one of kabane's own procedures; rename it",
			"Extension edges: copilot/procedures/doctor.md: the title DOCTOR is one of kabane's own procedures; rename it",
			"Extension edges: copilot/procedures/empty.md: its body is empty",
			"Extension edges: copilot/procedures/huge.md is over the 16 KiB a copilot file may hold",
			"Extension edges: copilot/procedures/two-lines.md: invalid frontmatter (title: must be one line)",
			"Extension edges: copilot/shortcuts must be a directory; it is a file",
		]);
		expect(read.refused.map((refusal) => refusal.file)).toContain(
			"copilot/shortcuts",
		);
	});

	it("ignores a copilot that is a file, and files not named *.md", () => {
		const read = CopilotFiles.read([
			extension("flat", { copilot: "not a directory" }),
			extension("other", { "copilot/procedures/notes.txt": "ignored" }),
		]);
		expect(read).toEqual({ procedures: [], shortcuts: [], refused: [] });
	});

	it("a shortcut name two extensions use is refused for both, and a built-in keeps its own", () => {
		const one = extension("one", {
			"copilot/shortcuts/go.md": shortcut("one's", "Go one way."),
			"copilot/shortcuts/only.md": shortcut("one's only", "Only one."),
		});
		const two = extension("two", {
			"copilot/shortcuts/go.md": shortcut("two's", "Go the other way."),
		});
		const read = CopilotFiles.read([one, two]);
		expect(read.shortcuts.map((s) => s.name)).toEqual(["only"]);
		expect(read.refused.map(Extensions.line)).toEqual([
			"Extension one: copilot/shortcuts/go.md: /go is also a shortcut of two, so neither is offered; rename one",
			"Extension two: copilot/shortcuts/go.md: /go is also a shortcut of one, so neither is offered; rename one",
		]);
		const triage = CopilotInstructions.shortcuts({
			configPath: "config.json",
			extensions: [],
			procedures: [],
			shortcuts: read.shortcuts,
		}).filter((s) => s.name === "triage");
		expect(triage).toEqual(
			CopilotInstructions.SHORTCUTS.filter((s) => s.name === "triage"),
		);
	});

	it("the loop's own files load whole, once, under a heading naming the loop", () => {
		const read = CopilotFiles.read([{ name: "loop", directory: LOOP }]);
		expect(read.refused).toEqual([]);
		expect(read.shortcuts).toEqual([]);
		const titles = read.procedures.flatMap((c) =>
			c.procedures.map((p) => p.title),
		);
		expect(titles.sort()).toEqual([
			"SETTING UP A LOOP RUN",
			"STARTING A LOOP RUN",
		]);
		const prompt = CopilotInstructions.systemPrompt(
			{
				configPath: "config.json",
				extensions: [{ name: "loop" }],
				procedures: read.procedures,
				shortcuts: read.shortcuts,
			},
			"kabane",
		);
		expect(prompt.split("EXTENSION loop.").length).toBe(2);
		expect(prompt.split("STARTING A LOOP RUN.").length).toBe(2);
		expect(prompt).not.toContain("{{extension}}");
		expect(prompt).toContain(`The loop extension, installed at ${LOOP},`);
		// What the procedure lets the copilot do, and what it must not do on its own idea.
		expect(prompt).toContain("`kabane loop start <id>`");
		expect(prompt).toContain(
			'When the human tells you to run an issue ("run JCAB-79 with codex"), that is the go-ahead',
		);
		expect(prompt).toContain(
			"When a run is your own suggestion, name the issue and the harness and wait for a yes",
		);
		expect(prompt).toContain(
			"pass only what the human asked for: the loop's settings (kabane_configGet key loop) supply the rest",
		);
		expect(prompt).toContain(
			"report its message as it is and do not retry with other flags",
		);
		expect(prompt).toContain("report the run id it prints");
		expect(prompt).toContain("`kabane loop status <runId>`");
		expect(prompt).toContain("`kabane loop stop <runId>`");
		expect(prompt).toContain(
			"The run's sessions change the code, not you, and a question one of them asks is the human's to answer.",
		);
		// Setting one up reads the advice first, proposes, and waits for a yes before it writes.
		expect(prompt).toContain("kabane loop advise <id>");
		expect(prompt).toContain("It starts nothing");
		expect(prompt).toContain(
			"an agent:<name> tag only for an agent the harness already has",
		);
		expect(prompt).toContain(
			"Your proposal is your own suggestion: wait for a yes",
		);
		expect(prompt).toContain("keeping each subtask's other tags");
		expect(prompt).toContain("start the run as STARTING A LOOP RUN says");
		expect(prompt).toContain(
			"Never change the implementer or the verifier unless asked",
		);
		expect(prompt.indexOf("EXTENSION loop.")).toBeGreaterThan(
			prompt.indexOf("KABANE ON THIS MACHINE."),
		);
	});
});

it("an enabled directory's files reach the board's copilot, and a refused one its announcer", async () => {
	const home = join(ROOT, "home");
	const notes = extension(
		"notes",
		{
			"package.json": JSON.stringify({
				kabane: { extension: "./index.ts", api: 1 },
			}),
			"index.ts": 'export default () => ({name: "notes"});',
			"copilot/procedures/keeping.md": procedure("KEEPING NOTES", "Keep them."),
			"copilot/shortcuts/note.md": shortcut("write a note", "Write a note."),
			"copilot/shortcuts/split.md": shortcut("mine", "Split my way."),
		},
		join(home, "extensions"),
	);
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "test",
			deviceId: "test",
			extensions: ["notes"],
			updates: { check: false },
		}),
	);
	const args = parseArgs([]);
	const ctx = await openContext(home, home, args);
	if (!ctx.ok) throw ctx.error;
	const all = await Extensions.loadAll(["notes"], home);
	expect(all.directories).toEqual([
		{ name: "notes", directory: realpathSync(notes.directory) },
	]);
	const wired = await boardDeps(args, ctx.value, "claude", {
		extensions: all.loaded,
		refusals: all.refused,
		directories: all.directories,
	});
	try {
		const names = wired.copilot.shortcuts().map((s) => s.name);
		expect(names).toEqual([
			...CopilotInstructions.SHORTCUTS.map((s) => s.name),
			"note",
		]);
		const notice = await wired.announcer?.announce();
		expect(notice?.ok && notice.value).toBe(
			"Extension notes file refused: copilot/shortcuts/split.md: /split is a built-in shortcut, which wins",
		);
	} finally {
		wired.copilot.close();
	}
});

it("several refused files are counted by extension and sent to doctor, apart from refused extensions", async () => {
	const home = join(ROOT, "several");
	const loaded = (name: string, files: Record<string, string>) =>
		extension(
			name,
			{
				"package.json": JSON.stringify({
					kabane: { extension: "./index.ts", api: 1 },
				}),
				"index.ts": `export default () => ({name: ${JSON.stringify(name)}});`,
				...files,
			},
			join(home, "extensions"),
		);
	loaded("notes", { "copilot/procedures/bare.md": "No frontmatter.\n" });
	loaded("clash", { "copilot/shortcuts/go.md": shortcut("clash", "Go.") });
	loaded("twin", { "copilot/shortcuts/go.md": shortcut("twin", "Go.") });
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "test",
			deviceId: "test",
			extensions: ["notes", "clash", "twin"],
			updates: { check: false },
		}),
	);
	const args = parseArgs([]);
	const ctx = await openContext(home, home, args);
	if (!ctx.ok) throw ctx.error;
	const all = await Extensions.loadAll(
		["notes", "clash", "twin", "gone"],
		home,
	);
	const wired = await boardDeps(args, ctx.value, "claude", {
		extensions: all.loaded,
		refusals: [],
		directories: all.directories,
	});
	const both = await boardDeps(args, ctx.value, "claude", {
		extensions: all.loaded,
		refusals: all.refused,
		directories: all.directories,
	});
	try {
		const notice = await wired.announcer?.announce();
		expect(notice?.ok && notice.value).toBe(
			"3 copilot files refused in notes, clash, twin; run kabane doctor for each",
		);
		const mixed = await both.announcer?.announce();
		expect(mixed?.ok && mixed.value).toStartWith(
			"Extension gone refused: not installed",
		);
		expect(mixed?.ok && mixed.value).toContain("; 3 copilot files refused");
		expect(mixed?.ok && mixed.value).not.toContain("--help");
	} finally {
		wired.copilot.close();
		both.copilot.close();
	}
});
