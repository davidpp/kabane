// The extension as kabane loads it: this directory linked into a disposable KABANE_HOME's
// extensions/, enabled in its config.json, and driven through the real `kabane` entry in a real
// project. Nothing here starts a terminal: hc has one core per user, holding the human's own
// sessions, so a started run is checked in the sandbox (AGENTS.md, "Verify").
import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXTENSION = resolve(import.meta.dir, "..");
const CLI = resolve(EXTENSION, "../../packages/cli/index.ts");
// bun and the system's tools, and no hc.
const NO_HC = `${dirname(process.execPath)}:/usr/bin:/bin`;

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

const RESEARCH = `---
description: Research an issue
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
  focus:
    required: true
---
Research {{target.shortId}} at {{inputs.depth}} depth, on {{inputs.focus}}.
`;

const setup = (extensions: readonly string[] = ["recipes"]) => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "recipes-ext-")));
	folders.push(folder);
	const root = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(root, ".kabane/recipes"), { recursive: true });
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(EXTENSION, join(home, "extensions/recipes"));
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({ actor: "test", deviceId: "test", extensions }),
	);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	writeFileSync(join(root, ".kabane/recipes/research.md"), RESEARCH);
	const kabane = (
		args: string[],
		options: { cwd?: string; path?: string } = {},
	) => {
		const result = Bun.spawnSync([process.execPath, CLI, ...args], {
			cwd: options.cwd ?? root,
			env: {
				...process.env,
				KABANE_HOME: home,
				KABANE_HARNESSES: "",
				...(options.path === undefined ? {} : { PATH: options.path }),
			},
			stdin: "ignore",
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString().trim(),
			stderr: result.stderr.toString().trim(),
		};
	};
	const issue = (): string => {
		const added = kabane(["add", "Look into it", "--kind", "issue", "--json"]);
		expect(added.code).toBe(0);
		return JSON.parse(added.stdout).shortId;
	};
	return { root, home, kabane, issue };
};

test("kabane run with no recipe lists the project's recipes and their inputs", () => {
	const { kabane } = setup();
	expect(kabane(["run"])).toEqual({
		code: 0,
		stdout: [
			"research --target <issue>  Research an issue",
			"    --input depth=<quick|medium|thorough> (default medium)",
			"    --input focus=<string> (required)",
		].join("\n"),
		stderr: "",
	});
});

test("a broken recipe is an error naming its file, beside the recipes that parse", () => {
	const { root, kabane } = setup();
	writeFileSync(join(root, ".kabane/recipes/bad.md"), "Hello {{inputs.who}}\n");
	const listed = kabane(["run"]);
	expect(listed.code).toBe(1);
	expect(listed.stderr).toContain("research --target <issue>");
	expect(listed.stderr).toContain(
		"Error: .kabane/recipes/bad.md: {{inputs.who}} names no declared input",
	);
	expect(kabane(["run", "bad"])).toMatchObject({
		code: 1,
		stderr:
			"Error: .kabane/recipes/bad.md: {{inputs.who}} names no declared input",
	});
});

test("outside a terminal, a missing required input is a usage error naming it", () => {
	const { kabane, issue } = setup();
	const id = issue();
	const missing = kabane(["run", "research", "--target", id]);
	expect(missing.code).toBe(2);
	expect(missing.stderr).toStartWith(
		'Error: recipe "research" needs focus: pass --input name=value\nUsage: kabane run',
	);
	expect(kabane(["run", "research"]).stderr).toStartWith(
		'Error: recipe "research" works on an issue: pass --target <issue>',
	);
	expect(
		kabane([
			"run",
			"research",
			"--target",
			id,
			"--input",
			"focus=x",
			"--input",
			"depth=deep",
		]).stderr,
	).toStartWith(
		'Error: input "depth" must be one of quick, medium, thorough, not "deep"',
	);
	expect(
		kabane(["run", "research", "--target", "JCAB-99999", "--input", "focus=x"])
			.stderr,
	).toBe("Error: No issue found: JCAB-99999");
});

test("a run with every input but no hc on PATH fails with one line naming hc, and records nothing", () => {
	const { kabane, issue } = setup();
	const id = issue();
	const run = kabane(
		["run", "research", "--target", id, "--json", '{"focus": "tests"}'],
		{
			path: NO_HC,
		},
	);
	expect(run.code).toBe(1);
	expect(JSON.parse(run.stdout || run.stderr).error).toStartWith(
		"hc (herdr core) is not on PATH",
	);
	expect(kabane(["runs", "--all"], { path: NO_HC }).stdout).toBe(
		"No runs in this project.",
	);
	const doctor = JSON.parse(
		kabane(["doctor", "--json"], { path: NO_HC }).stdout,
	);
	expect(doctor.findings).toContainEqual(
		expect.objectContaining({
			source: "recipes",
			id: "hc-missing",
			severity: "mention",
		}),
	);
});

test("run and runs outside a project fail with one line", () => {
	const { kabane, home } = setup();
	expect(kabane(["run", "research"], { cwd: home })).toMatchObject({
		code: 1,
		stderr: `Error: kabane run works inside a project, and ${home} is in none; run it from the project's folder`,
	});
	expect(kabane(["runs"], { cwd: home }).code).toBe(1);
});

test("runs refuses an unknown run and an unknown subcommand", () => {
	const { kabane } = setup();
	expect(kabane(["runs"]).stdout).toBe(
		"No live runs in this project; --all shows ended ones.",
	);
	expect(kabane(["runs", "read", "ABC123"]).stderr).toBe(
		'Error: No run "ABC123" in this project; kabane runs --all lists them',
	);
	expect(kabane(["runs", "poke", "x"]).code).toBe(2);
});

test("with the extension not enabled, run and runs are unknown and help lists neither", () => {
	const { kabane } = setup([]);
	const run = kabane(["run", "x"]);
	expect(run.code).toBe(2);
	expect(run.stderr).toStartWith("Error: Unknown command: run");
	const help = kabane(["--help"]).stdout;
	expect(help).not.toMatch(/^\s+run\s/m);
	expect(help).not.toMatch(/^\s+runs\s/m);
});
