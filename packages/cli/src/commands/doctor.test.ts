import { afterEach, expect, test } from "bun:test";
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
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Templates } from "@cabane/acp/templates";
import { type Result } from "@cabane/core";
import { Doctor, parseArgs } from "@cabane/extension";
import { DB_NAME } from "../config";
import { ConfigLayers } from "../config-layers";
import { openContext } from "../context";
import { Extensions } from "../extensions";
import { TRACKER_BLOCK } from "../first-run";
import { doctor } from "./doctor";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const folders: string[] = [];
afterEach(() => {
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
	expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
	writeFileSync(join(cwd, ".kabane/scope"), "pinned\n");
	// A project kabane set up with this version, so its project checks find nothing.
	mkdirSync(join(cwd, ".agents/skills/dispatch"), { recursive: true });
	writeFileSync(
		join(cwd, ".agents/skills/dispatch/SKILL.md"),
		`---\nname: dispatch\nmetadata:\n  kabane-template: ${unwrap(Templates.stamp("dispatch"))}\n---\n`,
	);
	writeFileSync(join(cwd, "AGENTS.md"), `${TRACKER_BLOCK}\n`);
	const spawn = (...args: string[]) => {
		const result = Bun.spawnSync(
			[process.execPath, resolve(import.meta.dir, "../../index.ts"), ...args],
			// No harness config is read: the machine's own registrations are not this test's.
			{ cwd, env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" } },
		);
		expect(result.exitCode).toBe(0);
		return {
			stdout: result.stdout.toString().trim(),
			stderr: result.stderr.toString(),
		};
	};
	const run = (...args: string[]) => {
		const { stdout, stderr } = spawn(...args);
		expect(stderr).toBe("");
		return stdout;
	};
	const config = (value: unknown) =>
		writeFileSync(join(home, "config.json"), JSON.stringify(value));
	return {
		cwd,
		home,
		cli: (...args: string[]) => run("doctor", ...args),
		run,
		spawn,
		config,
	};
};

test("clean home reports one line and closure-free JSON", () => {
	const { home, cli } = setup();
	expect(cli()).toBe("No findings.");
	expect(JSON.parse(cli("--json"))).toEqual({ findings: [], fixes: [] });
	expect(existsSync(join(home, DB_NAME))).toBe(false);
});

test("extension doctor counts open tier-tagged issues through the CLI store", () => {
	const { cli, run, config } = setup();
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["loop"],
	});
	run("add", "Unmapped tier", "--kind", "issue", "--tags", "tier:fast");
	const report = JSON.parse(cli("--json"));
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

test("reports unknown shared keys even with the extension disabled", () => {
	const { cwd, cli } = setup();
	const path = join(cwd, ".kabane/loop.json");
	writeFileSync(path, JSON.stringify({ mystery: 1 }));
	const report = JSON.parse(cli("--json"));
	expect(report.findings).toHaveLength(1);
	expect(report.findings[0]).toMatchObject({
		source: "kabane",
		path,
		severity: "mention",
		fixable: false,
	});
	expect(report.findings[0].summary).toContain("shared");
});

test("migrates only this project's legacy blocks and preserves other config", () => {
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
	const before = JSON.parse(cli("--json"));
	expect(
		before.findings.some(
			(finding: { severity: string }) => finding.severity === "auto",
		),
	).toBe(true);
	expect(before.findings.every((finding: object) => !("fix" in finding))).toBe(
		true,
	);
	const report = JSON.parse(cli("--fix", "--json"));
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
	expect(cli()).toContain("Run kabane doctor in that project");
});

test("selected repair refuses conflicting local settings without deleting legacy data", () => {
	const { cwd, home, cli, config } = setup();
	config({ scopes: { pinned: { loop: { concurrency: 2 } } } });
	const destination = ConfigLayers.localFile(home, cwd, "loop");
	expect(ConfigLayers.writeJson(destination, { concurrency: 3 }).ok).toBe(true);
	const report = JSON.parse(cli("--json"));
	const finding = report.findings.find((item: { id: string }) =>
		item.id.startsWith("legacy-settings-"),
	);
	expect(finding.severity).toBe("mention");
	const repaired = JSON.parse(cli("--fix", `kabane/${finding.id}`, "--json"));
	expect(
		JSON.parse(cli("--json")).findings.find(
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

test("malformed config is reported without opening a database", () => {
	const { home, cwd, cli } = setup();
	rmSync(join(cwd, ".agents"), { recursive: true });
	writeFileSync(join(home, "config.json"), "{broken");
	expect(cli()).toContain("config.json");
	expect(JSON.parse(cli("--json")).findings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				source: "kabane",
				id: "settings-check-failed",
			}),
			expect.objectContaining({
				source: "project",
				id: "dispatch-skill-missing",
			}),
		]),
	);
	expect(existsSync(join(home, DB_NAME))).toBe(false);
});

test("a throwing, malformed or refused extension doctor costs only that extension", () => {
	const { home, spawn, config } = setup();
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
	const { stdout, stderr } = spawn("doctor", "--json");
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
	run("add", "Directory doctor issue", "--kind", "issue");
	expect(JSON.parse(cli("--json")).findings).toContainEqual(
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

test("an unreadable store leaves the other doctor findings in text and JSON", () => {
	const { home, cwd, config, cli } = setup();
	config({
		actor: "cabane://actor/human/test",
		deviceId: "test",
		extensions: ["loop"],
	});
	writeFileSync(join(home, DB_NAME), "not a database");
	rmSync(join(cwd, ".agents"), { recursive: true });
	const report = JSON.parse(cli("--json"));
	expect(report.findings).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: "store-unavailable",
				severity: "mention",
				path: join(home, DB_NAME),
			}),
			expect.objectContaining({ id: "dispatch-skill-missing" }),
		]),
	);
	expect(cli()).toContain("Cannot open the store:");
});

test("a named missing fix is visible even with no findings", () => {
	const { cli } = setup();
	expect(cli("--fix", "nope")).toBe(
		"nope: No finding matches nope. Run kabane doctor to see current source/id handles.",
	);
	expect(cli("--fix", "kabane/nope")).toContain(
		"No finding matches kabane/nope",
	);
	expect(
		JSON.parse(cli("--fix", "kabane/nope", "--json")).fixes[0].result.ok,
	).toBe(false);
});

for (const linked of [false, true])
	test(`legacy settings repair preserves config mode and symlink (${linked})`, () => {
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
		const report = JSON.parse(cli("--fix", "--json"));
		expect(
			report.fixes.some((fix: { result: { ok: boolean } }) => fix.result.ok),
		).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(lstatSync(path).isSymbolicLink()).toBe(linked);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored.sync.token).toBe("private-token");
		expect(stored.scopes).toBeUndefined();
	});

test("settings diagnostics name usable keys and a concrete edit", () => {
	const { config, cli } = setup();
	config({ bogusTop: true, loop: { budget: { wallMinutes: 3 } } });
	const text = cli();
	expect(text).toContain("bogusTop in global");
	expect(text).not.toContain("device.bogusTop");
	expect(text).toContain("setting is no longer used");
	expect(text).toContain("to remove or correct this key");
});

test("legacy setting drift reports the file path separately from its key", () => {
	const { home, config, cli } = setup();
	config({ scopes: { pinned: { loop: { notASetting: true } } } });
	const report = JSON.parse(cli("--json"));
	const finding = report.findings.find((item: { id: string }) =>
		item.id.startsWith("unknown-setting-local"),
	);
	expect(finding.path).toBe(join(home, "config.json"));
	expect(finding.summary).toContain("scopes.pinned.loop");
});
