// The extension as kabane loads it: this directory linked into a disposable KABANE_HOME's
// extensions/, enabled in its config.json, and driven through the real `kabane` entry against real
// project directories. Nothing here builds a host by hand.
import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXTENSION = resolve(import.meta.dir, "..");
const CLI = resolve(EXTENSION, "../../packages/cli/index.ts");

// What `Templates.stamp("dispatch")` returned on main (e6b8506) for these same template bytes, before
// the templates moved here. A change to the template changes it: then a filled skill is behind,
// and this line moves with the template on purpose.
const STAMP_ON_MAIN = "dispatch@dacd7416f173";

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

const skill = (stamp?: string) =>
	`---\nname: dispatch\ndescription: Dispatch.\n${stamp === undefined ? "" : `metadata:\n  kabane-template: ${stamp}\n`}---\n\n# Dispatch\n`;

type Finding = {
	source: string;
	id: string;
	severity: string;
	summary: string;
};

/** A pinned git project with a current dispatch skill linked for Claude Code, and a home. */
const setup = (extensions: readonly string[] = ["dispatch"]) => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-ext-")));
	folders.push(folder);
	const root = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(root, ".kabane"), { recursive: true });
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(EXTENSION, join(home, "extensions/dispatch"));
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({ actor: "test", deviceId: "test", extensions }),
	);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	write(join(root, ".agents/skills/dispatch/SKILL.md"), skill(STAMP_ON_MAIN));
	mkdirSync(join(root, ".claude/skills"), { recursive: true });
	symlinkSync(
		"../../.agents/skills/dispatch",
		join(root, ".claude/skills/dispatch"),
	);
	const kabane = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, CLI, ...args], {
			cwd: root,
			env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString().trim(),
			stderr: result.stderr.toString(),
		};
	};
	const findings = (): Finding[] => {
		const { code, stdout } = kabane("doctor", "--json");
		expect(code).toBe(0);
		return JSON.parse(stdout).findings;
	};
	/** This extension's findings, as `id:severity`. */
	const ids = () =>
		findings()
			.filter(({ source }) => source === "dispatch")
			.map(({ id, severity }) => `${id}:${severity}`);
	return { root, home, kabane, findings, ids };
};

test("kabane dispatch stamp prints the stamp main computed for the same template bytes", () => {
	const { kabane } = setup();
	expect(kabane("dispatch", "stamp")).toEqual({
		code: 0,
		stdout: STAMP_ON_MAIN,
		stderr: "",
	});
	expect(JSON.parse(kabane("dispatch", "stamp", "--json").stdout)).toEqual({
		stamp: STAMP_ON_MAIN,
	});
	expect(kabane("dispatch").code).toBe(2);
	expect(kabane("dispatch", "hash").code).toBe(2);
});

test("a project kabane filled before the move has no findings, and none outside a project", () => {
	const { ids, kabane, home } = setup();
	expect(ids()).toEqual([]);
	const outside = Bun.spawnSync([process.execPath, CLI, "doctor", "--json"], {
		cwd: home,
		env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
	});
	expect(JSON.parse(outside.stdout.toString()).findings).toEqual([]);
	expect(kabane("doctor").stdout).not.toContain("dispatch/");
});

test("a missing dispatch skill routes to /setup-dispatch", () => {
	const { root, findings } = setup();
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude"), { recursive: true });
	expect(findings()).toContainEqual(
		expect.objectContaining({
			source: "dispatch",
			id: "dispatch-skill-missing",
			severity: "suggest",
			route: "/setup-dispatch writes one",
		}),
	);
});

test("an unstamped skill and an old stamp are told apart", () => {
	const { root, ids, findings } = setup();
	const path = join(root, ".agents/skills/dispatch/SKILL.md");
	writeFileSync(path, skill());
	expect(ids()).toEqual(["dispatch-skill-unstamped:route"]);
	writeFileSync(path, skill("dispatch@000000000000"));
	expect(ids()).toEqual(["dispatch-skill-behind:route"]);
	const behind = findings().find(({ source }) => source === "dispatch");
	expect(behind?.summary).toContain("dispatch@000000000000");
	expect(behind?.summary).toContain(STAMP_ON_MAIN);
});

test("a real .claude/skills/dispatch directory is reported, a symlink is not", () => {
	const { root, ids } = setup();
	rmSync(join(root, ".agents"), { recursive: true });
	rmSync(join(root, ".claude/skills/dispatch"));
	write(join(root, ".claude/skills/dispatch/SKILL.md"), skill(STAMP_ON_MAIN));
	expect(ids()).toEqual(["dispatch-skill-location:route"]);
});

test("CRLF keeps the skill's stamp readable", () => {
	const { root, ids } = setup();
	writeFileSync(
		join(root, ".agents/skills/dispatch/SKILL.md"),
		skill(STAMP_ON_MAIN).replaceAll("\n", "\r\n"),
	);
	expect(ids()).toEqual([]);
});

test("an edited grill copy is reported and --fix dispatch/grill-skill-behind restores it", () => {
	const { root, ids, kabane } = setup();
	const template = readFileSync(join(EXTENSION, "templates/grill/SKILL.md"));
	const path = join(root, ".agents/skills/grill/SKILL.md");
	write(path, template.toString());
	symlinkSync("../../.agents/skills/grill", join(root, ".claude/skills/grill"));
	expect(ids()).toEqual([]);
	writeFileSync(path, `${template}\nA project edit.\n`);
	expect(ids()).toEqual(["grill-skill-behind:mention"]);
	const unasked = JSON.parse(kabane("doctor", "--fix", "--json").stdout);
	expect(unasked.fixes).toEqual([]);
	const fixed = JSON.parse(
		kabane("doctor", "--fix", "dispatch/grill-skill-behind", "--json").stdout,
	);
	expect(fixed.fixes).toHaveLength(1);
	expect(fixed.fixes[0].result.ok).toBe(true);
	expect(readFileSync(path).equals(template)).toBe(true);
	expect(ids()).toEqual([]);
});

test("disabled, the extension checks nothing and adds no command", () => {
	const { root, ids, kabane } = setup([]);
	rmSync(join(root, ".agents"), { recursive: true });
	expect(ids()).toEqual([]);
	expect(kabane("dispatch", "stamp").code).not.toBe(0);
	expect(kabane("--help").stdout).not.toContain("dispatch");
});
