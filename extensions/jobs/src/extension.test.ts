import { Database } from "bun:sqlite";
// The extension as kabane loads it: this directory linked into a disposable KABANE_HOME's
// extensions/, enabled in its config.json, and driven through the real `kabane` entry in a real
// project. Nothing here starts a terminal: hc has one core per user, holding the human's own
// sessions, so a started run is checked in the sandbox (AGENTS.md, "Verify").
import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
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
`;

/** A project skill with nothing in it but its name: kabane only names it to the harness. */
const skill = (root: string, name: string) => {
	mkdirSync(join(root, ".agents/skills", name), { recursive: true });
	writeFileSync(
		join(root, ".agents/skills", name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name}\n---\n`,
	);
};

const setup = (extensions: readonly string[] = ["jobs"]) => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "jobs-ext-")));
	folders.push(folder);
	const root = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(root, ".kabane/recipes"), { recursive: true });
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(EXTENSION, join(home, "extensions/jobs"));
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({ actor: "test", deviceId: "test", extensions }),
	);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	writeFileSync(join(root, ".kabane/recipes/research.md"), RESEARCH);
	skill(root, "research");
	const kabane = (
		args: string[],
		options: {
			cwd?: string;
			path?: string;
			home?: string;
			env?: Record<string, string>;
		} = {},
	) => {
		const result = Bun.spawnSync([process.execPath, CLI, ...args], {
			cwd: options.cwd ?? root,
			env: {
				...process.env,
				KABANE_HOME: home,
				KABANE_HARNESSES: "",
				...(options.path === undefined ? {} : { PATH: options.path }),
				...(options.home === undefined ? {} : { HOME: options.home }),
				...options.env,
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
	/** A run row as `kabane run` writes it, put straight into the table: no terminal starts. */
	const seed = (
		id: string,
		fields: {
			machine?: string;
			state?: string;
			runtime?: string;
			session?: string;
			/** A folder of the project to record it in; this one when absent. */
			cwd?: string;
		} = {},
	) => {
		// The scope the folder resolves to, read from an issue made there.
		const added = kabane(["add", "Scope probe", "--json"], { cwd: fields.cwd });
		const scope = JSON.parse(added.stdout).scopeUri as string;
		const db = new Database(join(home, "kabane.db"));
		try {
			db.run(
				`INSERT INTO jobs_runs (id, recipe, recipe_hash, target_kind, target_id, scope_uri,
				   dir, machine, cwd, runtime, session, inputs, state, started_at, ended_at, updated_at)
				 VALUES (?, 'research', 'abc', NULL, NULL, ?, '', ?, ?, ?, ?, '{}', ?, ?, NULL, ?)`,
				[
					id,
					scope,
					fields.machine ?? hostname(),
					root,
					fields.runtime ?? "hc",
					fields.session ?? `kabane-test-${id.slice(-6).toLowerCase()}`,
					fields.state ?? "running",
					new Date().toISOString(),
					new Date().toISOString(),
				],
			);
		} finally {
			db.close();
		}
	};
	return { root, home, kabane, issue, seed };
};

test("kabane run with no recipe lists the project's recipes and their inputs", () => {
	const { kabane } = setup();
	expect(kabane(["run"])).toEqual({
		code: 0,
		stdout: [
			"research --target <issue>  Research an issue",
			"    skill research  (.agents/skills/research/SKILL.md)",
			"    harness claude  (kabane's default)",
			"    --input depth=<quick|medium|thorough> (default medium)",
			"    --input focus=<string> (required)",
		].join("\n"),
		stderr: "",
	});
});

test("kabane run with no recipe names each recipe's harness and where it comes from", () => {
	const { root, kabane } = setup();
	writeFileSync(
		join(root, ".kabane/recipes/probe.md"),
		"---\nharness: [codex, exec]\n---\n",
	);
	skill(root, "probe");
	expect(
		kabane([
			"config",
			"set",
			"jobs.harness",
			"sh,-c,echo hi",
			"--layer",
			"global",
		]).code,
	).toBe(0);
	expect(kabane(["run"]).stdout.split("\n")).toEqual([
		"probe",
		"    skill probe  (.agents/skills/probe/SKILL.md)",
		"    harness codex exec  (from the recipe)",
		"research --target <issue>  Research an issue",
		"    skill research  (.agents/skills/research/SKILL.md)",
		"    harness sh -c 'echo hi'  (from jobs.harness)",
		"    --input depth=<quick|medium|thorough> (default medium)",
		"    --input focus=<string> (required)",
	]);
});

test("kabane run with no recipe says a recipe with a body has its own prompt", () => {
	const { root, kabane } = setup();
	writeFileSync(
		join(root, ".kabane/recipes/tidy.md"),
		"---\ndescription: Tidy the README\n---\nTidy the README.\n",
	);
	expect(kabane(["run"]).stdout.split("\n").slice(-3)).toEqual([
		"tidy  Tidy the README",
		"    its own prompt  (.kabane/recipes/tidy.md)",
		"    harness claude  (kabane's default)",
	]);
});

test("a broken recipe is an error naming its file, beside the recipes that parse", () => {
	const { root, kabane } = setup();
	writeFileSync(
		join(root, ".kabane/recipes/bad.md"),
		"---\nskill: gone\n---\n",
	);
	const why =
		'Error: .kabane/recipes/bad.md: no skill "gone": kabane looked for .agents/skills/gone/SKILL.md and .claude/skills/gone/SKILL.md';
	const listed = kabane(["run"]);
	expect(listed.code).toBe(1);
	expect(listed.stderr).toContain("research --target <issue>");
	expect(listed.stderr).toContain(why);
	expect(kabane(["run", "bad"])).toMatchObject({ code: 1, stderr: why });
});

test("outside a terminal, a missing required input is a usage error naming it", () => {
	const { kabane, issue } = setup();
	const id = issue();
	const missing = kabane(["run", "research", "--target", id]);
	expect(missing.code).toBe(2);
	expect(missing.stderr).toStartWith(
		'Error: recipe "research" needs focus: pass --input focus=<value> or add it to the inputs JSON\nUsage: kabane run',
	);
	expect(
		kabane([
			"run",
			"research",
			'{"focus": "x"}',
			"--target",
			id,
			"--inputs",
			'{"focus": "y"}',
		]),
	).toMatchObject({
		code: 2,
		stderr: expect.stringContaining(
			"Error: Give the inputs JSON once: with --inputs or after the recipe name\n",
		),
	});
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
		["run", "research", "--target", id, "--inputs", '{"focus": "tests"}'],
		{
			path: NO_HC,
		},
	);
	expect(run.code).toBe(1);
	expect(run.stderr).toStartWith("Error: hc (herdr core) is not on PATH");
	const json = kabane(
		["run", "research", "--target", id, "--json", '{"focus": "tests"}'],
		{ path: NO_HC },
	);
	expect(JSON.parse(json.stdout || json.stderr).error).toStartWith(
		"hc (herdr core) is not on PATH",
	);
	expect(kabane(["runs", "--ended"], { path: NO_HC }).stdout).toBe(
		"No runs in this project; --all shows every project's.",
	);
	const doctor = JSON.parse(
		kabane(["doctor", "--json"], { path: NO_HC }).stdout,
	);
	expect(doctor.findings).toContainEqual(
		expect.objectContaining({
			source: "jobs",
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
		"No runs in flight in this project; --ended shows ended ones, --all shows every project's.",
	);
	expect(kabane(["runs", "read", "ABC123"]).stderr).toBe(
		'Error: No run "ABC123" in any project; kabane runs --all --ended lists them all',
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

test("runs lists the runs in flight unless --ended, and refuses another machine's run by name", () => {
	const { kabane, seed } = setup();
	kabane(["runs"]); // opens the store, which creates the run table
	seed("01M7JT0TFJB7MF38VYDWCG0AAA", { machine: "elsewhere" });
	seed("01M7JT0TFJB7MF38VYDWCG0BAA", { machine: "elsewhere", state: "ended" });
	// Without hc nothing is reconciled, so each row shows what it recorded.
	const live = JSON.parse(kabane(["runs", "--json"], { path: NO_HC }).stdout);
	expect(live.runs.map((r: { id: string }) => r.id)).toEqual([
		"01M7JT0TFJB7MF38VYDWCG0AAA",
	]);
	expect(kabane(["runs"], { path: NO_HC }).stdout).toContain(
		"running (on elsewhere)",
	);
	const all = JSON.parse(
		kabane(["runs", "--ended", "--json"], { path: NO_HC }).stdout,
	);
	expect(all.runs.map((r: { state: string }) => r.state).sort()).toEqual([
		"ended",
		"running",
	]);
	for (const verb of ["attach", "read", "stop"])
		expect(kabane(["runs", verb, "aaa"])).toMatchObject({
			code: 1,
			stderr: `Error: Run 01M7JT0TFJB7MF38VYDWCG0AAA runs on elsewhere, not on this machine (${hostname()}); ${verb} it there`,
		});
	expect(kabane(["runs", "send", "AAA", "yes"]).stderr).toContain(
		"runs on elsewhere",
	);
	expect(kabane(["runs", "read", "aa"]).stderr).toBe(
		'Error: "aa" names 2 runs (01M7JT0TFJB7MF38VYDWCG0BAA in pinned, 01M7JT0TFJB7MF38VYDWCG0AAA in pinned); give more of the id',
	);
});

test("a run's id, whole or its end, reaches it from any folder: this project's first, then any project's or none", () => {
	const { kabane, seed, home, root } = setup();
	kabane(["runs"]);
	const other = join(dirname(root), "other");
	mkdirSync(join(other, ".kabane"), { recursive: true });
	expect(Bun.spawnSync(["git", "init", "-q", other]).exitCode).toBe(0);
	writeFileSync(join(other, ".kabane/scope"), "other\n");
	seed("01M7JT0TFJB7MF38VYDWCG0GGG", { machine: "elsewhere" });
	seed("01M7JT0TFJB7MF38VYDWCG1HHH", { machine: "elsewhere" });
	seed("01M7JT0TFJB7MF38VYDWCG2HHH", { machine: "elsewhere", cwd: other });
	// The machine check is past the lookup: reaching it names the run that was found.
	const found = (id: string) =>
		`Error: Run ${id} runs on elsewhere, not on this machine (${hostname()}); attach it there`;
	for (const cwd of [other, home]) {
		expect(
			kabane(["runs", "attach", "01m7jt0tfjb7mf38vydwcg0ggg"], { cwd }),
		).toMatchObject({ code: 1, stderr: found("01M7JT0TFJB7MF38VYDWCG0GGG") });
		expect(kabane(["runs", "attach", "ggg"], { cwd })).toMatchObject({
			code: 1,
			stderr: found("01M7JT0TFJB7MF38VYDWCG0GGG"),
		});
	}
	// One run in each project ends with "hhh": each project finds its own; outside both, it names both.
	expect(kabane(["runs", "attach", "hhh"]).stderr).toBe(
		found("01M7JT0TFJB7MF38VYDWCG1HHH"),
	);
	expect(kabane(["runs", "attach", "hhh"], { cwd: other }).stderr).toBe(
		found("01M7JT0TFJB7MF38VYDWCG2HHH"),
	);
	expect(kabane(["runs", "attach", "hhh"], { cwd: home }).stderr).toBe(
		'Error: "hhh" names 2 runs (01M7JT0TFJB7MF38VYDWCG2HHH in other, 01M7JT0TFJB7MF38VYDWCG1HHH in pinned); give more of the id',
	);
});

test("runs --all lists every project's runs with their project, from any folder", () => {
	const { kabane, seed, home, root } = setup();
	kabane(["runs"]);
	const other = join(dirname(root), "other");
	mkdirSync(join(other, ".kabane"), { recursive: true });
	expect(Bun.spawnSync(["git", "init", "-q", other]).exitCode).toBe(0);
	writeFileSync(join(other, ".kabane/scope"), "other\n");
	seed("01M7JT0TFJB7MF38VYDWCG0AAA", { machine: "elsewhere" });
	seed("01M7JT0TFJB7MF38VYDWCG0BBB", { machine: "elsewhere", cwd: other });
	seed("01M7JT0TFJB7MF38VYDWCG0CCC", {
		machine: "elsewhere",
		state: "ended",
		cwd: other,
	});
	const ids = (args: string[], cwd?: string) =>
		JSON.parse(
			kabane(["runs", ...args, "--json"], { cwd, path: NO_HC }).stdout,
		).runs.map((r: { id: string }) => r.id);
	expect(ids([])).toEqual(["01M7JT0TFJB7MF38VYDWCG0AAA"]);
	expect(ids(["--all"], home).sort()).toEqual([
		"01M7JT0TFJB7MF38VYDWCG0AAA",
		"01M7JT0TFJB7MF38VYDWCG0BBB",
	]);
	expect(ids(["--all", "--ended"]).sort()).toEqual([
		"01M7JT0TFJB7MF38VYDWCG0AAA",
		"01M7JT0TFJB7MF38VYDWCG0BBB",
		"01M7JT0TFJB7MF38VYDWCG0CCC",
	]);
	const table = kabane(["runs", "--all"], { path: NO_HC }).stdout.split("\n");
	expect(table[0]).toStartWith("ID                          PROJECT  STATE");
	expect(table.slice(1).map((row) => row.split(/\s+/).slice(0, 2))).toEqual(
		expect.arrayContaining([
			["01M7JT0TFJB7MF38VYDWCG0AAA", "pinned"],
			["01M7JT0TFJB7MF38VYDWCG0BBB", "other"],
		]),
	);
});

test("a run in a runtime this kabane lacks keeps its recorded state, and its verbs name that runtime", () => {
	const { kabane, seed } = setup();
	kabane(["runs"]);
	seed("01M7JT0TFJB7MF38VYDWCG0EEE", { runtime: "cloud", session: "s-1" });
	// hc reconciles this machine's runs, and leaves the cloud one as recorded.
	expect(
		JSON.parse(kabane(["runs", "--json"]).stdout).runs.map(
			(r: { state: string; session: string }) => [r.state, r.session],
		),
	).toEqual([["running", "s-1"]]);
	for (const verb of ["attach", "read", "stop"])
		expect(kabane(["runs", verb, "eee"])).toMatchObject({
			code: 1,
			stderr:
				"Error: Run 01M7JT0TFJB7MF38VYDWCG0EEE runs in cloud, which this kabane does not have",
		});
});

test("every verb on a run with no terminal yet stops at the hc adapter", () => {
	const { kabane, seed } = setup();
	kabane(["runs"]);
	seed("01M7JT0TFJB7MF38VYDWCG0FFF", { session: "" });
	// Without hc on PATH a call that went on to hc would fail naming hc instead.
	for (const args of [["stop"], ["read"], ["attach"], ["send", "yes"]]) {
		const [verb, ...rest] = args;
		expect(
			kabane(["runs", verb ?? "", "fff", ...rest], { path: NO_HC }),
		).toMatchObject({
			code: 1,
			stderr: "Error: This run has no terminal: its start never recorded one",
		});
	}
});

// Reads one terminal through the real hc, by a name no terminal has: hc answers not found and
// nothing of the human's is touched. Skipped where hc is not installed.
test.skipIf(Bun.which("hc") === null)(
	"runs writes back the state hc reports for this machine's runs and leaves another machine's",
	() => {
		const { kabane, seed } = setup();
		kabane(["runs"]);
		seed("01M7JT0TFJB7MF38VYDWCG0CCC", {
			session: `kabane-test-gone-${Date.now().toString(36)}`,
		});
		seed("01M7JT0TFJB7MF38VYDWCG0DDD", { machine: "elsewhere" });
		expect(
			JSON.parse(kabane(["runs", "--json"]).stdout).runs.map(
				(r: { id: string }) => r.id,
			),
		).toEqual(["01M7JT0TFJB7MF38VYDWCG0DDD"]);
		const all = JSON.parse(
			kabane(["runs", "--ended", "--json"], { path: NO_HC }).stdout,
		).runs as { id: string; state: string; endedAt?: string }[];
		const gone = all.find((r) => r.id.endsWith("CCC"));
		expect(gone?.state).toBe("ended");
		expect(Date.parse(gone?.endedAt ?? "")).not.toBeNaN();
		expect(all.find((r) => r.id.endsWith("DDD"))?.state).toBe("running");
	},
);

const WIKI = `---
description: Tend the wiki
inputs:
  focus:
    required: true
  depth:
    options: [quick, thorough]
    default: quick
---
Tend the wiki, starting with {{inputs.focus}}.
`;

test("job add --project makes the job in that folder's project from anywhere, and job edit changes it from anywhere", () => {
	const { kabane, home, root } = setup();
	writeFileSync(join(root, ".kabane/recipes/wiki.md"), WIKI);
	const outside = { cwd: home };
	expect(
		kabane(
			[
				"job",
				"add",
				"--title",
				"Nowhere",
				"--schedule",
				"0 9 * * *",
				"--request",
				"x",
				"--project",
				home,
			],
			outside,
		),
	).toMatchObject({
		code: 1,
		stderr: `Error: --project ${home} is in no kabane project`,
	});
	const added = kabane(
		[
			"job",
			"add",
			"wiki",
			"--title",
			"Wiki",
			"--schedule",
			"*/5 * * * *",
			"--input",
			"focus=overviews",
			"--project",
			"../project",
			"--json",
		],
		outside,
	);
	expect(added.code).toBe(0);
	const { shortId } = JSON.parse(added.stdout);
	// tick's folder for the project is the one --project named, not the cwd.
	const show = () =>
		JSON.parse(kabane(["job", "show", shortId, "--json"], outside).stdout).job;
	expect(show()).toMatchObject({
		schedule: "*/5 * * * *",
		recipe: "wiki",
		inputs: { focus: "overviews", depth: "quick" },
		starts: { argv: ["claude"] },
	});
	expect(kabane(["job", "edit", shortId], outside)).toMatchObject({ code: 2 });
	expect(
		kabane(["job", "edit", shortId, "--schedule", "nope"], outside).code,
	).toBe(2);
	expect(
		kabane(["job", "edit", shortId, "--input", "depth=deep"], outside).code,
	).toBe(2);
	const edited = kabane(
		[
			"job",
			"edit",
			shortId,
			"--schedule",
			"0 9 * * *",
			"--harness",
			"codex",
			"--input",
			"depth=thorough",
			"--title",
			"Wiki daily",
			"--session",
			"keep",
		],
		outside,
	);
	expect(edited.code).toBe(0);
	expect(edited.stdout).toMatch(
		/^Edited job \S+ \(title "Wiki daily", schedule "0 9 \* \* \*", inputs \{"focus":"overviews","depth":"thorough"\}, harness codex, keep session\); it fires next at \d{4}-\d\d-\d\d 09:00\.$/,
	);
	expect(show()).toMatchObject({
		title: "Wiki daily",
		schedule: "0 9 * * *",
		inputs: { focus: "overviews", depth: "thorough" },
		harness: ["codex"],
		session: "keep",
	});
	// --inputs replaces the set; --harness none hands the choice back to jobs.harness.
	expect(
		kabane(
			[
				"job",
				"edit",
				shortId,
				"--inputs",
				'{"focus":"index"}',
				"--harness",
				"none",
			],
			outside,
		).code,
	).toBe(0);
	const after = show();
	expect(after.inputs).toEqual({ focus: "index", depth: "quick" });
	expect(after.harness).toBeUndefined();
	expect(after.starts).toMatchObject({ argv: ["claude"] });
});

test("doctor offers the user-level job skill, and --fix installs it for every harness", () => {
	const { kabane, home } = setup();
	const user = join(home, "user");
	mkdirSync(user);
	const findings = () =>
		JSON.parse(kabane(["doctor", "--json"], { home: user }).stdout).findings;
	expect(findings()).toContainEqual(
		expect.objectContaining({
			source: "jobs",
			id: "job-skill-missing",
			severity: "suggest",
			fixable: true,
		}),
	);
	const fixed = kabane(["doctor", "--fix", "jobs/job-skill-missing"], {
		home: user,
	});
	expect(fixed.code).toBe(0);
	expect(fixed.stdout).toContain(
		"Wrote ~/.agents/skills/job/SKILL.md and linked ~/.claude/skills/job to it",
	);
	expect(readFileSync(join(user, ".claude/skills/job/SKILL.md"), "utf8")).toBe(
		readFileSync(join(EXTENSION, "skills/job/SKILL.md"), "utf8"),
	);
	expect(
		findings().filter((f: { id: string }) => f.id.startsWith("job-skill")),
	).toEqual([]);
});

test("with nothing ticking this machine, job add says how to install the tick and doctor offers it once a job exists", () => {
	const { kabane, home } = setup();
	const user = join(home, "user");
	mkdirSync(user);
	const tickFindings = () =>
		JSON.parse(
			kabane(["doctor", "--json"], { home: user }).stdout,
		).findings.filter((f: { id: string }) => f.id === "job-tick-missing");
	expect(tickFindings()).toEqual([]);
	const added = kabane(
		[
			"job",
			"add",
			"--title",
			"Tidy",
			"--schedule",
			"0 9 * * *",
			"--request",
			"Tidy the inbox",
		],
		{ home: user },
	);
	expect(added.code).toBe(0);
	// stdin is not a terminal, as in an agent's shell: a line to relay, and nothing installed.
	expect(added.stdout).toContain(
		"Nothing runs kabane job tick on this machine yet, so no job fires: `kabane doctor --fix jobs/job-tick-missing` installs a",
	);
	expect(tickFindings()).toEqual([
		expect.objectContaining({
			source: "jobs",
			severity: "suggest",
			fixable: true,
		}),
	]);
});

/**
 * A user home and a PATH whose `launchctl` and `crontab` only record their calls, so a check that
 * installs the tick never reaches the real launchd session or crontab, whatever HOME says.
 */
const tickTools = (home: string) => {
	const user = join(home, "user");
	const tools = join(home, "tools");
	mkdirSync(user);
	mkdirSync(tools);
	const calls = join(tools, "calls");
	writeFileSync(
		join(tools, "launchctl"),
		`#!/bin/sh\necho "launchctl $*" >> '${calls}'\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(tools, "crontab"),
		`#!/bin/sh\necho "crontab $*" >> '${calls}'\nif [ "$1" = -l ]; then cat '${tools}/table' 2>/dev/null || { echo "no crontab for test" >&2; exit 1; }; else cat > '${tools}/table'; fi\n`,
		{ mode: 0o755 },
	);
	const called = (): string[] =>
		existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
	return { user, path: `${tools}:${NO_HC}`, called };
};

const ADD_TIDY = [
	"job",
	"add",
	"--title",
	"Tidy",
	"--schedule",
	"0 9 * * *",
	"--request",
	"Tidy the inbox",
];

test("with KABANE_JOB_TICK=print, as the sandbox sets it, the tick's fix says what it would install and installs nothing", () => {
	const { kabane, home } = setup();
	const { user, path, called } = tickTools(home);
	const options = { home: user, path, env: { KABANE_JOB_TICK: "print" } };
	expect(kabane(ADD_TIDY, options).code).toBe(0);
	const fixed = kabane(["doctor", "--fix", "jobs/job-tick-missing"], options);
	expect(fixed.code).toBe(0);
	expect(fixed.stdout).toContain("KABANE_JOB_TICK=print: would");
	expect(fixed.stdout).toContain("job tick");
	// Detection may read the crontab; nothing may write it or load an agent.
	expect(called().filter((call) => call !== "crontab -l")).toEqual([]);
	expect(existsSync(join(user, "Library/LaunchAgents"))).toBe(false);
	expect(existsSync(join(home, "tools/table"))).toBe(false);
});

test("a tick whose program is gone is reported, and doctor --fix points it at the running kabane", () => {
	const { kabane, home } = setup();
	const { user, path, called } = tickTools(home);
	const gone = join(home, "old-install/kabane");
	const agent = join(user, "Library/LaunchAgents/com.kabane.job-tick.plist");
	const table = join(home, "tools/table");
	if (process.platform === "darwin") {
		mkdirSync(dirname(agent), { recursive: true });
		writeFileSync(
			agent,
			`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.kabane.job-tick</string><key>ProgramArguments</key><array><string>${gone}</string><string>job</string><string>tick</string></array></dict></plist>\n`,
		);
	} else writeFileSync(table, `* * * * * ${gone} job tick\n`);
	const options = { home: user, path };
	expect(kabane(ADD_TIDY, options).code).toBe(0);
	const doctor = kabane(["doctor"], options).stdout;
	expect(doctor).toContain(`runs ${gone}, which is gone`);
	const fixed = kabane(["doctor", "--fix", "jobs/job-tick-missing"], options);
	expect(fixed.code).toBe(0);
	const written = readFileSync(
		process.platform === "darwin" ? agent : table,
		"utf8",
	);
	expect(written).not.toContain(gone);
	expect(written).toContain(CLI);
	if (process.platform === "darwin")
		expect(called()).toEqual([
			expect.stringMatching(
				/^launchctl bootout gui\/\d+\/com\.kabane\.job-tick$/,
			),
			expect.stringMatching(
				/^launchctl bootstrap gui\/\d+ .*com\.kabane\.job-tick\.plist$/,
			),
		]);
	expect(kabane(["doctor"], options).stdout).not.toContain("job-tick-missing");
});

test("a job add whose schedule fails to store cancels its item, so a retry leaves one job", () => {
	const { kabane, home } = setup();
	const add = ["job", "add", "--title", "Steward", "--schedule", "0 9 * * *"];
	expect(kabane([...add, "--request", "warm up"]).code).toBe(0);
	// The write that failed on the 2.0 beta (a foreign key the extension's old copy kept), as any
	// failure of the row's insert: the item is filed by then.
	const db = new Database(join(home, "kabane.db"));
	const refuse = () =>
		db.run(
			"CREATE TRIGGER refuse BEFORE INSERT ON jobs_jobs BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
		);
	try {
		refuse();
	} finally {
		db.close();
	}
	const failed = kabane([...add, "--request", "tend"]);
	expect(failed.code).toBe(1);
	const short = /job (\S+): /.exec(failed.stderr)?.[1] ?? "";
	expect(failed.stderr).toBe(
		`Error: Could not store the schedule of job ${short}: FOREIGN KEY constraint failed. ${short} is cancelled, so nothing is left half-added.`,
	);
	expect(
		JSON.parse(kabane(["show", short, "--json"]).stdout).task,
	).toMatchObject({
		kind: "job",
		state: "cancelled",
	});

	const fixed = new Database(join(home, "kabane.db"));
	try {
		fixed.run("DROP TRIGGER refuse");
	} finally {
		fixed.close();
	}
	expect(kabane([...add, "--request", "tend"]).code).toBe(0);
	const listed = JSON.parse(kabane(["job", "list", "--json"]).stdout).jobs as {
		title: string;
	}[];
	expect(listed.map(({ title }) => title)).toEqual(["Steward", "Steward"]);
	// The tracker holds the same two open, and the cancelled item beside them.
	const items = JSON.parse(
		kabane(["list", "--kind", "job", "--all", "--json"]).stdout,
	) as { state: string }[];
	expect(items.map(({ state }) => state).toSorted()).toEqual([
		"cancelled",
		"next",
		"next",
	]);
});

test("job show names the repair of a job item with no schedule, and the repair leaves one job", () => {
	const { kabane } = setup();
	// What a `job add` that failed after filing its item left before it cancelled one.
	const orphan = JSON.parse(
		kabane(["add", "Steward", "--kind", "job", "--state", "next", "--json"])
			.stdout,
	).shortId as string;
	expect(kabane(["job", "show", orphan])).toMatchObject({
		code: 1,
		stderr: `Error: ${orphan} is an item of kind job with no schedule, as a \`kabane job add\` that failed after filing it leaves one: cancel it with \`kabane edit ${orphan} --state cancelled\`, then add the job again`,
	});
	expect(kabane(["edit", orphan, "--state", "cancelled"]).code).toBe(0);
	const added = kabane([
		"job",
		"add",
		"--title",
		"Steward",
		"--schedule",
		"0 9 * * *",
		"--request",
		"tend",
		"--json",
	]);
	expect(added.code).toBe(0);
	const listed = JSON.parse(kabane(["job", "list", "--json"]).stdout).jobs as {
		id: string;
	}[];
	expect(listed).toHaveLength(1);
	expect(kabane(["job", "show", JSON.parse(added.stdout).shortId]).code).toBe(
		0,
	);
});
