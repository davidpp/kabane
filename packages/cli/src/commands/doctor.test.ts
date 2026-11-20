import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	chmodSync,
	lstatSync,
	statSync,
	symlinkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Doctor, parseArgs } from "@kabane/extension";
import { DB_NAME } from "../config";
import { ConfigLayers } from "../config-layers";
import { openContext } from "../context";
import { Extensions } from "../extensions";
import { TRACKER_BLOCK } from "../first-run";
import { run as runCommand } from "../main";
import { doctor } from "./doctor";

const folders: string[] = [];
let harnesses: string | undefined;
beforeEach(() => {
	harnesses = process.env.KABANE_HARNESSES;
	// Install checks read process.env rather than run()'s home-resolution argument.
	process.env.KABANE_HARNESSES = "";
});
afterEach(() => {
	if (harnesses === undefined) delete process.env.KABANE_HARNESSES;
	else process.env.KABANE_HARNESSES = harnesses;
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});
const setup = () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "kabane-doctor-")));
	folders.push(folder);
	const cwd = join(folder, "project");
	const home = join(folder, "home");
	mkdirSync(join(cwd, ".kabane"), { recursive: true });
	mkdirSync(home);
	mkdirSync(join(home, "extensions"));
	symlinkSync(
		join(import.meta.dir, "../../../../extensions/loop"),
		join(home, "extensions/loop"),
	);
	expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
	writeFileSync(join(cwd, ".kabane/scope"), "pinned\n");
	// A project kabane set up with this version, so its project checks find nothing.
	writeFileSync(join(cwd, "AGENTS.md"), `${TRACKER_BLOCK}\n`);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const invoke = async (...args: string[]) => {
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const outcome = await runCommand(
				args.filter((arg) => arg !== "--json"),
				env,
				cwd,
			);
			expect(outcome.exitCode).toBe(0);
			return {
				...outcome,
				stdout: args.includes("--json")
					? JSON.stringify(outcome.json)
					: outcome.text,
				stderr: errors.mock.calls.map((call) => call.join(" ")).join("\n"),
			};
		} finally {
			errors.mockRestore();
		}
	};
	const run = async (...args: string[]) => {
		const { stdout, stderr } = await invoke(...args);
		expect(stderr).toBe("");
		return stdout;
	};
	const config = (value: Record<string, unknown>) =>
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				actor: "test",
				deviceId: "test",
				extensions: ["loop"],
				...value,
			}),
		);
	return {
		cwd,
		home,
		env,
		cli: (...args: string[]) => run("doctor", ...args),
		run,
		invoke,
		config,
	};
};

test("clean home reports one line and closure-free JSON", async () => {
	const { home, cli } = setup();
	expect(await cli()).toBe("No findings.");
	expect(JSON.parse(await cli("--json"))).toEqual({ findings: [], fixes: [] });
	expect(existsSync(join(home, DB_NAME))).toBe(false);
});

// A project /setup-dispatch filled before the dispatch skill left base kabane: its stamp is what
// main (e6b8506) computed. It keeps working untouched; doctor says only what it can know.
test("a stamped dispatch skill is mentioned without the dispatch extension, and checked by it", async () => {
	const { cwd, home, cli, config } = setup();
	const path = join(cwd, ".agents/skills/dispatch/SKILL.md");
	mkdirSync(join(cwd, ".agents/skills/dispatch"), { recursive: true });
	const skill =
		"---\nname: dispatch\nmetadata:\n  kabane-template: dispatch@aee0f7efee11\n---\n";
	writeFileSync(path, skill);
	const without = JSON.parse(await cli("--json")).findings;
	expect(without).toEqual([
		expect.objectContaining({
			source: "project",
			id: "skill-unchecked",
			severity: "mention",
			path,
		}),
	]);
	expect(await cli()).toContain("no enabled extension is named dispatch");
	symlinkSync(
		join(import.meta.dir, "../../../../extensions/dispatch"),
		join(home, "extensions/dispatch"),
	);
	config({ extensions: ["dispatch"] });
	expect(JSON.parse(await cli("--json")).findings).toEqual([]);
	expect(readFileSync(path, "utf8")).toBe(skill);
});

// The stamp is YAML, read as YAML: flow style counts, a stamp-like line inside another field's
// text does not, and a frontmatter that does not parse is no stamped skill.
test("a skill's stamp is read from its parsed frontmatter, in any YAML style", async () => {
	const { cwd, cli } = setup();
	const path = join(cwd, ".agents/skills/dispatch/SKILL.md");
	mkdirSync(join(cwd, ".agents/skills/dispatch"), { recursive: true });
	const unchecked = async (frontmatter: string) => {
		writeFileSync(path, `---\n${frontmatter}\n---\n\n# Dispatch\n`);
		return JSON.parse(await cli("--json")).findings.map(
			({ source, id }: { source: string; id: string }) => `${source}/${id}`,
		);
	};
	expect(
		await unchecked(
			"name: dispatch\nmetadata: {kabane-template: dispatch@aee0f7efee11}",
		),
	).toEqual(["project/skill-unchecked"]);
	expect(
		await unchecked(
			"name: dispatch\ndescription: |\n  Our own skill.\n  kabane-template: dispatch@aee0f7efee11",
		),
	).toEqual([]);
	expect(
		await unchecked(
			"name: [unclosed\nmetadata:\n  kabane-template: dispatch@aee0f7efee11",
		),
	).toEqual([]);
});

// The loop cannot know whether the dispatch extension is there: its advice holds either way.
test("the loop's legacy-lens finding names the dispatch extension and a manual route", async () => {
	const { cwd, cli, config } = setup();
	config({});
	mkdirSync(join(cwd, ".kabane/loop/lenses"), { recursive: true });
	writeFileSync(
		join(cwd, ".kabane/loop/lenses/security.md"),
		"Review security.\n",
	);
	const finding = JSON.parse(await cli("--json")).findings.find(
		({ id }: { id: string }) => id === "legacy-lens-dir",
	);
	expect(finding).toMatchObject({
		source: "loop",
		id: "legacy-lens-dir",
		severity: "mention",
	});
	expect(finding.summary).toContain(
		".agents/skills/dispatch/references/lenses",
	);
	expect(finding.summary).toContain("/setup-dispatch");
	expect(finding.summary).toContain("by hand");
	expect(finding.summary).toContain("dispatch extension");

	mkdirSync(join(cwd, ".agents/skills/dispatch/references/lenses"), {
		recursive: true,
	});
	renameSync(
		join(cwd, ".kabane/loop/lenses/security.md"),
		join(cwd, ".agents/skills/dispatch/references/lenses/security.md"),
	);
	expect(
		JSON.parse(await cli("--json")).findings.map(
			({ id }: { id: string }) => id,
		),
	).not.toContain("legacy-lens-dir");
});

test("extension doctor counts open tier-tagged issues through the CLI store", async () => {
	const { cli, run, config } = setup();
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["loop"],
	});
	await run("add", "Unmapped tier", "--kind", "issue", "--tags", "tier:fast");
	const report = JSON.parse(await cli("--json"));
	expect(report.findings).toContainEqual(
		expect.objectContaining({
			source: "loop",
			id: "tier-unmapped",
			summary: expect.stringContaining("1 open issue tagged for it"),
		}),
	);
	expect(
		report.findings.some(
			(finding: { id: string }) =>
				finding.id === "tier-tags-unchecked" || finding.id === "check-failed",
		),
	).toBe(false);
});

test("inspects shared keys only after enabling the directory extension", async () => {
	const { cwd, cli, config } = setup();
	const path = join(cwd, ".kabane/loop.json");
	writeFileSync(path, JSON.stringify({ mystery: 1 }));
	expect(JSON.parse(await cli("--json")).findings).toEqual([]);
	config({});
	const report = JSON.parse(await cli("--json"));
	expect(report.findings).toHaveLength(1);
	expect(report.findings[0]).toMatchObject({
		source: "kabane",
		path,
		severity: "mention",
		fixable: false,
	});
	expect(report.findings[0].summary).toContain("shared");
});

test("migrates only this project's legacy blocks and preserves other config", async () => {
	const { cwd, home, cli, config } = setup();
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		mystery: true,
		scopes: {
			pinned: { loop: { concurrency: 2 } },
			elsewhere: { loop: { concurrency: 3 } },
		},
	});
	const before = JSON.parse(await cli("--json"));
	expect(
		before.findings.some(
			(finding: { severity: string }) => finding.severity === "auto",
		),
	).toBe(true);
	expect(before.findings.every((finding: object) => !("fix" in finding))).toBe(
		true,
	);
	const report = JSON.parse(await cli("--fix", "--json"));
	expect(report.fixes).toHaveLength(1);
	expect(report.fixes[0].result.ok).toBe(true);
	expect(
		JSON.parse(readFileSync(ConfigLayers.localFile(home, cwd, "loop"), "utf8")),
	).toEqual({ concurrency: 2 });
	expect(
		JSON.parse(readFileSync(join(home, "config.json"), "utf8")),
	).toMatchObject({
		mystery: true,
		scopes: { elsewhere: { loop: { concurrency: 3 } } },
	});
	expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain(
		"pinned",
	);
	expect(await cli()).toContain("Run kabane doctor in that project");
});

test("selected repair refuses conflicting local settings without deleting legacy data", async () => {
	const { cwd, home, cli, config } = setup();
	config({ scopes: { pinned: { loop: { concurrency: 2 } } } });
	const destination = ConfigLayers.localFile(home, cwd, "loop");
	expect(ConfigLayers.writeJson(destination, { concurrency: 3 }).ok).toBe(true);
	const report = JSON.parse(await cli("--json"));
	const finding = report.findings.find((item: { id: string }) =>
		item.id.startsWith("legacy-settings-"),
	);
	expect(finding.severity).toBe("mention");
	const repaired = JSON.parse(
		await cli("--fix", `kabane/${finding.id}`, "--json"),
	);
	expect(
		JSON.parse(await cli("--json")).findings.find(
			(item: { id: string }) => item.id === finding.id,
		).severity,
	).toBe("mention");
	expect(repaired.fixes[0].result).toMatchObject({ ok: false });
	expect(repaired.fixes[0].result.error).toContain("Refused");
	expect(readFileSync(join(home, "config.json"), "utf8")).toContain("pinned");
	expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({
		concurrency: 3,
	});
});

test("malformed config is reported without opening a database", async () => {
	const { home, cwd, cli } = setup();
	rmSync(join(cwd, "AGENTS.md"));
	writeFileSync(join(home, "config.json"), "{broken");
	expect(await cli()).toContain("config.json");
	expect(JSON.parse(await cli("--json")).findings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				source: "kabane",
				id: "settings-check-failed",
			}),
			expect.objectContaining({
				source: "project",
				id: "tracker-block-missing",
			}),
		]),
	);
	expect(existsSync(join(home, DB_NAME))).toBe(false);
});

test("a throwing, malformed or refused extension doctor costs only that extension", async () => {
	const { home, invoke, config } = setup();
	const install = (name: string, source: string) => {
		const dir = join(home, "extensions", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ kabane: { extension: "./index.ts", api: 1 } }),
		);
		writeFileSync(join(dir, "index.ts"), source);
	};
	install(
		"throws",
		'export default () => ({name: "throws", doctor: async () => {throw new Error("doctor broke");}});',
	);
	install(
		"malformed",
		'export default () => ({name: "malformed", doctor: async () => [{id: "x", severity: "mention", summary: "?"}]});',
	);
	install(
		"refused",
		'export default () => ({name: "refused", doctor: "not a function"});',
	);
	install(
		"fine",
		'export default host => ({name: "fine", doctor: async () => host.result.ok([{id: "noted", severity: "mention", summary: "fine ran"}])});',
	);
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["throws", "malformed", "refused", "fine"],
	});
	const { stdout, stderr } = await invoke("doctor", "--json");
	// The loader's one line for a refused extension, as every other command prints it.
	expect(stderr.trim().split("\n")).toEqual([
		expect.stringContaining(
			"Extension refused: the factory returned an invalid Extension: doctor must be a function",
		),
	]);
	const report = JSON.parse(stdout);
	const by = (source: string) =>
		report.findings.filter(
			(finding: { source: string }) => finding.source === source,
		);
	expect(by("fine")).toEqual([
		expect.objectContaining({ id: "noted", summary: "fine ran" }),
	]);
	expect(by("throws")).toEqual([
		expect.objectContaining({
			id: "check-failed",
			summary: expect.stringContaining("doctor broke"),
		}),
	]);
	expect(by("malformed")).toEqual([
		expect.objectContaining({
			id: "check-failed",
			summary: expect.stringContaining("returned an invalid report"),
		}),
	]);
	expect(by("refused")).toEqual([
		expect.objectContaining({
			id: "extension-refused",
			summary: expect.stringContaining("Extension refused:"),
		}),
	]);
});

test("a directory doctor reads the live record and stays staged when config cannot open the store", async () => {
	const { home, cwd, cli, run, config } = setup();
	const dir = join(home, "extensions", "records");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ kabane: { extension: "./index.ts", api: 1 } }),
	);
	writeFileSync(
		join(dir, "index.ts"),
		`export default host => ({
		name: "records",
		doctor: async () => {
			const rows = await host.record.list({});
			return host.result.ok([{ id: "record", severity: "mention", summary: rows.ok ? rows.value.map(row => row.title).join(", ") : rows.error.message }]);
		}
	});`,
	);
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["records"],
	});
	await run("add", "Directory doctor issue", "--kind", "issue");
	expect(JSON.parse(await cli("--json")).findings).toContainEqual(
		expect.objectContaining({
			source: "records",
			id: "record",
			summary: "Directory doctor issue",
		}),
	);
	const ctx = await openContext(home, cwd, parseArgs([]));
	if (!ctx.ok) throw ctx.error;
	const loaded = await Extensions.loadAll(["records"], home);
	expect(loaded.refused).toEqual([]);
	writeFileSync(join(home, "config.json"), "{broken");
	const outcome = await doctor.run(parseArgs([]), ctx.value);
	expect(outcome.exitCode).toBe(0);
	expect(outcome.text).toContain("config.json");
	// Invalid JSON cannot supply enabled names. A previously loaded check still receives the
	// stage error after doctor declines to open that store, rather than a stale live context.
	const report = await Doctor.run(Extensions.doctors(loaded.loaded), ctx.value);
	expect(report.findings[0]?.summary).toContain(
		"standalone commands do not open it automatically",
	);
});

test("an unreadable store leaves the other doctor findings in text and JSON", async () => {
	const { home, cwd, config, cli } = setup();
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["loop"],
	});
	writeFileSync(join(home, DB_NAME), "not a database");
	rmSync(join(cwd, "AGENTS.md"));
	const report = JSON.parse(await cli("--json"));
	expect(report.findings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "store-unavailable",
				severity: "mention",
				path: join(home, DB_NAME),
			}),
			expect.objectContaining({ id: "tracker-block-missing" }),
		]),
	);
	expect(await cli()).toContain("Cannot open the store:");
});

test("a named missing fix is visible even with no findings", async () => {
	const { cli } = setup();
	expect(await cli("--fix", "nope")).toBe(
		"nope: No finding matches nope. Run kabane doctor to see current source/id handles.",
	);
	expect(await cli("--fix", "kabane/nope")).toContain(
		"No finding matches kabane/nope",
	);
	expect(
		JSON.parse(await cli("--fix", "kabane/nope", "--json")).fixes[0].result.ok,
	).toBe(false);
});

for (const linked of [false, true])
	test(`legacy settings repair preserves config mode and symlink (${linked})`, async () => {
		const { home, config, cli } = setup();
		const path = join(home, "config.json");
		config({
			scopes: { pinned: { loop: { concurrency: 2 } } },
			sync: { token: "private-token" },
		});
		if (linked) {
			const target = join(home, "managed-config.json");
			writeFileSync(target, readFileSync(path));
			rmSync(path);
			symlinkSync(target, path);
		}
		chmodSync(path, 0o600);
		const report = JSON.parse(await cli("--fix", "--json"));
		expect(
			report.fixes.some((fix: { result: { ok: boolean } }) => fix.result.ok),
		).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(lstatSync(path).isSymbolicLink()).toBe(linked);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored.sync.token).toBe("private-token");
		expect(stored.scopes).toBeUndefined();
	});

test("settings diagnostics name usable keys and a concrete edit", async () => {
	const { config, cli } = setup();
	config({ bogusTop: true, loop: { budget: { wallMinutes: 3 } } });
	const text = await cli();
	expect(text).toContain("bogusTop in global");
	expect(text).not.toContain("device.bogusTop");
	expect(text).toContain("setting is no longer used");
	expect(text).toContain("to remove or correct this key");
});

test("legacy setting drift reports the file path separately from its key", async () => {
	const { home, config, cli } = setup();
	config({ scopes: { pinned: { loop: { notASetting: true } } } });
	const report = JSON.parse(await cli("--json"));
	const finding = report.findings.find((item: { id: string }) =>
		item.id.startsWith("unknown-setting-local"),
	);
	expect(finding.path).toBe(join(home, "config.json"));
	expect(finding.summary).toContain("scopes.pinned.loop");
});

for (const known of ["enabled", "directory", "neither"] as const) {
	test(`doctor preserves unloaded extension settings named by ${known}`, async () => {
		const { home, cwd, env, config, invoke } = setup();
		if (known !== "directory") rmSync(join(home, "extensions/loop"));
		config({
			extensions: known === "enabled" ? ["loop"] : [],
			loop: { stallAfter: 7 },
		});
		const unavailable = await runCommand(
			["config", "get", "loop.stallAfter"],
			env,
			cwd,
		);
		expect(unavailable.exitCode).toBe(1);
		expect(unavailable.text).toContain("Unknown config key");
		const before = readFileSync(join(home, "config.json"), "utf8");
		const report = JSON.parse((await invoke("doctor", "--json")).stdout);
		const unknown = report.findings.filter((finding: { id: string }) =>
			finding.id.startsWith("unknown-setting-global-device-loop-"),
		);
		expect(unknown).toHaveLength(known === "neither" ? 1 : 0);
		// Its settings stay for when it is enabled, so doctor never advises deleting them.
		if (known === "neither") {
			expect(unknown[0]).toMatchObject({
				id: expect.stringMatching(/^unknown-setting-global-device-loop-/),
				severity: "mention",
			});
			expect(unknown[0].summary).toContain("loop in global");
			expect(unknown[0].summary).toContain("kept for when it is enabled");
			expect(unknown[0].summary).not.toContain("remove");
		}
		if (known === "enabled")
			expect(
				report.findings.some((finding: { id: string }) =>
					finding.id.startsWith("extension-refused"),
				),
			).toBe(true);
		expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
		if (known !== "directory")
			symlinkSync(
				join(import.meta.dir, "../../../../extensions/loop"),
				join(home, "extensions/loop"),
			);
		await invoke("config", "set", "extensions", "loop", "--layer", "global");
		expect((await invoke("config", "get", "loop.stallAfter")).stdout).toBe("7");
	});
}

test("a device key named in extensions keeps the device settings check", async () => {
	const { config, invoke } = setup();
	config({ extensions: ["loop", "updates"], updates: { chek: false } });
	const { stdout, stderr } = await invoke("doctor", "--json");
	expect(stderr).toContain("Extension updates: not installed");
	const finding = JSON.parse(stdout).findings.find((item: { id: string }) =>
		item.id.startsWith("unknown-setting-global-device-updates-"),
	);
	expect(finding.summary).toStartWith(
		"updates.chek in global: unknown device setting",
	);
});
