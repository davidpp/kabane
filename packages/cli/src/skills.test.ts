// Real extension directories on disk, read by the real reader and served by the real `kabane mcp`.
import { afterAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { Extensions } from "./extensions";
import { Skills } from "./skills";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kabane-skills-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

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

const skill = (name: string, description: string, body: string): string =>
	`---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n${body}\n`;

const KEEP = {
	"skills/keep-notes/SKILL.md": skill(
		"keep-notes",
		"Use when the human asks to keep notes.",
		"Copy {{extension}}/templates/notes.md, then run `{{kabane}} notes add`. Read references/how.md.",
	),
	"skills/keep-notes/references/how.md": "Run {{kabane}} --help.\n",
	"skills/.hidden/SKILL.md": "not a skill",
	"skills/keep-notes/.env": "TOKEN=hidden",
	"secret.md": "outside the skill",
};

describe("Skills.read", () => {
	it("reads each skill's name and description, and refuses the unusable ones one at a time", () => {
		const notes = extension("notes", {
			...KEEP,
			"skills/bare/SKILL.md": "No frontmatter.\n",
			"skills/no-description/SKILL.md":
				"---\nname: no-description\n---\nBody\n",
			"skills/misnamed/SKILL.md": skill("other", "Use it.", "Body"),
			"skills/Upper/SKILL.md": skill("Upper", "Use it.", "Body"),
			"skills/empty/notes.md": "no SKILL.md",
			"skills/loose.md": "a file, not a skill",
		});
		const { skills, refused } = Skills.read([notes]);
		expect(skills.slice(1)).toEqual([
			{
				name: "keep-notes",
				description: "Use when the human asks to keep notes.",
				extension: "notes",
				root: notes.directory,
				directory: join(notes.directory, "skills/keep-notes"),
			},
		]);
		expect(refused).toEqual([
			{
				name: "notes",
				file: "skills/Upper",
				reason:
					"skills/Upper/SKILL.md: invalid frontmatter (name: must be lowercase letters and digits joined by single hyphens)",
			},
			{
				name: "notes",
				file: "skills/bare",
				reason:
					"skills/bare/SKILL.md has no frontmatter between --- lines; add one",
			},
			{
				name: "notes",
				file: "skills/empty",
				reason: "skills/empty/SKILL.md cannot be read; a skill needs one",
			},
			{
				name: "notes",
				file: "skills/loose.md",
				reason: "skills/loose.md must be a directory holding SKILL.md",
			},
			{
				name: "notes",
				file: "skills/misnamed",
				reason:
					"skills/misnamed/SKILL.md: its name other is not its directory's; name both alike",
			},
			{
				name: "notes",
				file: "skills/no-description",
				reason:
					"skills/no-description/SKILL.md: invalid frontmatter (description: Required)",
			},
		]);
	});

	it("refuses a name two extensions ship in both, and serves the rest", () => {
		const one = extension("one", {
			"skills/go/SKILL.md": skill("go", "One's.", "Go."),
			"skills/stay/SKILL.md": skill("stay", "Stay.", "Stay."),
		});
		const two = extension("two", {
			"skills/go/SKILL.md": skill("go", "Two's.", "Go."),
		});
		const { skills, refused } = Skills.read([one, two]);
		expect(skills.map(({ name }) => name)).toEqual(["kabane", "stay"]);
		expect(refused.map(({ name, reason }) => [name, reason])).toEqual([
			[
				"one",
				"skills/go: two also ships a skill named go, so neither is served; rename one",
			],
			[
				"two",
				"skills/go: one also ships a skill named go, so neither is served; rename one",
			],
		]);
	});

	it("serves base kabane's skill with no extension, and refuses an extension's skill named like it", () => {
		expect(
			Skills.tools([extension("bare", { "x.md": "" })], "kabane").map(
				({ name }) => name,
			),
		).toEqual(["kabane_skillList", "kabane_skillGet"]);
		const { skills, refused } = Skills.read([
			extension("mimic", {
				"skills/kabane/SKILL.md": skill("kabane", "Not base.", "Body"),
			}),
		]);
		expect(skills.map(({ name, extension }) => [name, extension])).toEqual([
			["kabane", "kabane"],
		]);
		expect(refused).toEqual([
			{
				name: "mimic",
				file: "skills/kabane",
				reason:
					"skills/kabane: kabane itself ships a skill named kabane, so this one is not served; rename it",
			},
		]);
	});
});

describe("Skills.get", () => {
	const notes = extension("notes", KEEP);
	symlinkSync(
		join(notes.directory, "secret.md"),
		join(notes.directory, "skills/keep-notes/link.md"),
	);
	const { skills } = Skills.read([notes]);
	const kabane = Skills.command("/home/it's", "/bin/kabane");

	it("returns SKILL.md filled, and the manifest of the skill's other files", () => {
		const got = Skills.get(skills, "keep-notes", undefined, kabane);
		if (!got.ok) throw got.error;
		expect(got.value).toEqual({
			name: "keep-notes",
			extension: "notes",
			file: "SKILL.md",
			text: `---\nname: keep-notes\ndescription: Use when the human asks to keep notes.\nlicense: MIT\n---\nCopy ${notes.directory}/templates/notes.md, then run \`KABANE_HOME='/home/it'\\''s' '/bin/kabane' notes add\`. Read references/how.md.\n`,
			files: ["references/how.md"],
		});
		const how = Skills.get(skills, "keep-notes", "references/how.md", kabane);
		if (!how.ok) throw how.error;
		expect(how.value.text).toBe(`Run ${kabane} --help.\n`);
		expect(how.value.files).toEqual(["SKILL.md"]);
	});

	it("refuses a file outside the skill, by path or through a link, and an unknown skill", () => {
		for (const file of [
			"../../secret.md",
			"/etc/hosts",
			"link.md",
			".env",
			"references",
			"nope.md",
		]) {
			const got = Skills.get(skills, "keep-notes", file, kabane);
			expect(got.ok ? got.value : got.error.message).toBe(
				`${file} is not a file of the skill keep-notes; ask for SKILL.md or one of the files it lists`,
			);
		}
		const unknown = Skills.get(skills, "other", undefined, kabane);
		expect(unknown.ok ? unknown.value : unknown.error.message).toBe(
			"No skill is named other; kabane_skillList names the skills served",
		);
	});

	it("serves a skill holding an unreadable directory and file, and refuses its unreadable files", () => {
		const locked = extension("locked", {
			"skills/demo/SKILL.md": skill("demo", "Use it.", "Body"),
			"skills/demo/references/how.md": "How.\n",
			"skills/demo/locked/inside.md": "Hidden by its directory.\n",
			"skills/demo/sealed.md": "Unreadable.\n",
		});
		const demo = join(locked.directory, "skills/demo");
		chmodSync(join(demo, "locked"), 0o000);
		chmodSync(join(demo, "sealed.md"), 0o000);
		try {
			const read = Skills.read([locked]);
			const got = Skills.get(read.skills, "demo", undefined, kabane);
			if (!got.ok) throw got.error;
			expect(got.value.files).toEqual(["references/how.md", "sealed.md"]);
			const sealed = Skills.get(read.skills, "demo", "sealed.md", kabane);
			expect(sealed.ok ? sealed.value : sealed.error.message).toStartWith(
				"sealed.md ",
			);
			const inside = Skills.get(
				read.skills,
				"demo",
				"locked/inside.md",
				kabane,
			);
			expect(inside.ok).toBe(false);
		} finally {
			chmodSync(join(demo, "locked"), 0o755);
			chmodSync(join(demo, "sealed.md"), 0o644);
		}
	});
});

it("kabane mcp lists and serves an enabled extension's skill over stdio", async () => {
	const home = join(ROOT, "home");
	const bin = join(import.meta.dir, "../index.ts");
	const notes = extension(
		"notes",
		{
			...KEEP,
			"package.json": JSON.stringify({
				kabane: { extension: "./index.ts", api: 1 },
			}),
			"index.ts": 'export default () => ({name: "notes"});',
		},
		join(home, "extensions"),
	);
	const env = { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" };
	const init = Bun.spawnSync(
		[
			process.execPath,
			bin,
			"init",
			"--actor",
			"cabane://actor/human/skills",
			"--device",
			"skills",
		],
		{ cwd: home, env },
	);
	expect(init.exitCode).toBe(0);
	const set = Bun.spawnSync(
		[
			process.execPath,
			bin,
			"config",
			"set",
			"extensions",
			"notes",
			"--layer",
			"global",
		],
		{ cwd: home, env },
	);
	expect(set.exitCode).toBe(0);
	const client = new Client({ name: "skills-test", version: "1" });
	const text = async (name: string, args: Record<string, unknown>) => {
		const result = z
			.object({
				isError: z.boolean().optional(),
				content: z.array(
					z.object({ type: z.literal("text"), text: z.string() }),
				),
			})
			.parse(await client.callTool({ name, arguments: args }));
		return {
			error: result.isError ?? false,
			text: result.content.map((part) => part.text).join("\n"),
		};
	};
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [bin, "mcp"],
				cwd: home,
				env,
				stderr: "pipe",
			}),
		);
		const names = (await client.listTools()).tools.map(({ name }) => name);
		expect(names).toContain("kabane_skillList");
		expect(names).toContain("kabane_skillGet");
		expect(client.getInstructions()).toContain(Skills.INSTRUCTIONS);
		// Base text: the line holds whatever extensions are enabled, so it names none.
		expect(Skills.INSTRUCTIONS).not.toMatch(/dispatch|grill|loop/i);
		expect(JSON.parse((await text("kabane_skillList", {})).text)).toEqual({
			skills: [
				{
					name: "kabane",
					description: expect.stringContaining("Base kabane's own how-to"),
					extension: "kabane",
				},
				{
					name: "keep-notes",
					description: "Use when the human asks to keep notes.",
					extension: "notes",
				},
			],
		});
		const got = await text("kabane_skillGet", { name: "keep-notes" });
		expect(got.error).toBe(false);
		const body = JSON.parse(got.text) as Skills.Got;
		expect(body.text).toContain(`Copy ${notes.directory}/templates/notes.md`);
		expect(body.text).toContain(`run \`KABANE_HOME='${home}' '`);
		expect(body.text).not.toContain("{{");
		expect(body.files).toEqual(["references/how.md"]);
		const escaped = await text("kabane_skillGet", {
			name: "keep-notes",
			file: "../../secret.md",
		});
		expect(escaped.error).toBe(true);
		expect(escaped.text).toContain("is not a file of the skill keep-notes");
	} finally {
		await client.close();
	}
});

it("the loop's loop-run skill sets up and starts a run with the kabane this server runs", () => {
	const loop = {
		name: "loop",
		directory: join(import.meta.dir, "../../../extensions/loop"),
	};
	const read = Skills.read([loop]);
	expect(read.refused).toEqual([]);
	const got = Skills.get(read.skills, "loop-run", undefined, "KABANE");
	if (!got.ok) throw got.error;
	const text = got.value.text;
	expect(got.value.files).toEqual([]);
	expect(text).not.toContain("{{");
	// Setting one up reads the advice first, proposes, and waits for a yes before it writes.
	for (const line of [
		"`KABANE loop advise <id>`",
		"It starts nothing",
		"an agent:<name> tag only for an agent the harness already has",
		"Never change the implementer or the verifier unless asked",
		"Your proposal is your own suggestion: wait for a yes",
		"keeping each subtask's other tags",
		"Never pass layer: shared",
		// What starting lets the session do, and what it must not do on its own idea.
		"`KABANE loop start <id>`",
		'When the human tells you to run an issue ("run JCAB-79 with codex"), that is the go-ahead',
		"When a run is your own suggestion, name the issue and the harness and wait for a yes",
		"pass only what the human asked for: the loop's settings (kabane_configGet key loop) supply the rest",
		"report its message as it is and do not retry with other flags",
		"report the run id it prints",
		"`KABANE loop status <runId>`",
		"`KABANE loop stop <runId>`",
		"The run's sessions change the code, not you, and a question one of them asks is the human's to answer.",
	])
		expect(text).toContain(line);
});

describe("base kabane's kabane skill", () => {
	const { skills } = Skills.read([]);
	const kabane = "KABANE";
	const file = (path?: string): string => {
		const got = Skills.get(skills, "kabane", path, kabane);
		if (!got.ok) throw got.error;
		return got.value.text;
	};

	it("routes each task to one reference, every one of which it serves filled", () => {
		const got = Skills.get(skills, "kabane", undefined, kabane);
		if (!got.ok) throw got.error;
		// Its files are imported one by one, so a file added to the directory and not to
		// skills.ts would go unserved: the directory and what is served must match.
		const shipped = readdirSync(join(import.meta.dir, "../skills/kabane"), {
			recursive: true,
			withFileTypes: true,
		})
			.filter((entry) => entry.isFile())
			.map((entry) =>
				relative(
					join(import.meta.dir, "../skills/kabane"),
					join(entry.parentPath, entry.name),
				),
			)
			.sort();
		expect(["SKILL.md", ...got.value.files].sort()).toEqual(shipped);
		expect(got.value.files).toEqual([
			"references/config.md",
			"references/doctor.md",
			"references/linking.md",
		]);
		for (const reference of got.value.files) {
			expect(got.value.text).toContain(`\`${reference}\``);
			expect(file(reference)).not.toContain("{{");
		}
		expect(got.value.text).toContain("Run kabane in your shell as `KABANE`");
		const missing = Skills.get(skills, "kabane", "references/none.md", kabane);
		expect(missing.ok ? undefined : missing.error.message).toBe(
			"references/none.md is not a file of the skill kabane; ask for SKILL.md or one of the files it lists",
		);
	});

	it("puts the substance in the task's own description and identity on the link", () => {
		const linking = file("references/linking.md");
		expect(linking).toContain("kabane_edit");
		expect(linking).toContain("kabane_upstream_link");
		expect(linking).toContain(
			"Never put the external issue's body on the link",
		);
	});

	it("changes config through the tools, by layer, applying a named change and waiting on a suggested one", () => {
		const config = file("references/config.md");
		expect(config).toContain("kabane_configGet");
		expect(config).toContain("kabane_configSet");
		expect(config).toContain("layer: local");
		expect(config).toContain("Never pass layer: shared");
		expect(config).toContain("When kabane_configSet returns shadowedBy");
		expect(config).toContain("When the human names the setting and its value");
		expect(config).toContain("When the change is your own suggestion");
		expect(config).toContain("whose readOnly or protected flag is true");
		expect(config).toContain("`KABANE --help`");
	});

	it("enables an installed extension by keeping the list, passing it whole and reopening the board", () => {
		const enable = file("references/config.md")
			.split("\n\n")
			.find((paragraph) =>
				paragraph.startsWith("To enable an installed extension"),
			);
		expect(enable).toContain("INSTALLED EXTENSIONS");
		expect(enable).toContain(
			"the options kabane_configGet reports for the key extensions",
		);
		expect(enable).toContain("preserve every existing entry in the new list");
		expect(enable).toContain("full comma-separated list");
		expect(enable).toContain("key extensions");
		expect(enable).toContain("say what it adds from its description");
		expect(enable).toContain("enabling it starts none");
		expect(enable).toContain("remind the human to reopen the board");
	});

	it("doctor reads the report once, fixes only auto findings unasked and never the MCP entries", () => {
		const doctor = file("references/doctor.md");
		expect(doctor).toContain("run `KABANE doctor --json` once");
		expect(doctor).toContain(
			"Run `KABANE doctor --fix` once, without asking first",
		);
		expect(doctor).toContain(
			"Run `KABANE doctor --fix <source>/<id>` only after an explicit yes",
		);
		expect(doctor).toContain(
			"Never run the fix of a kabane/mcp-entry-stale-<harness> finding",
		);
		expect(doctor).toContain(
			"`kabane doctor --fix kabane/mcp-entry-stale-<harness>`",
		);
		expect(doctor).toContain(
			"never run a fix as a side effect of another request",
		);
		// A route to any skill, an extension's included, keeps that skill's rules on asking.
		expect(doctor).toContain("offer to run that skill");
		expect(doctor).toContain("write waits for a yes");
	});

	it("names no extension", () => {
		const got = Skills.get(skills, "kabane", undefined, kabane);
		if (!got.ok) throw got.error;
		for (const path of [undefined, ...got.value.files])
			expect(file(path)).not.toMatch(/dispatch|grill|\bloop\b|recipes/i);
	});
});
