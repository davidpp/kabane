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
const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

import { DB_NAME } from "../config";
import { ConfigLayers } from "../config-layers";
import { TRACKER_BLOCK } from "../first-run";

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
	const run = (...args: string[]) => {
		const result = Bun.spawnSync(
			[process.execPath, resolve(import.meta.dir, "../../index.ts"), ...args],
			// No harness config is read: the machine's own registrations are not this test's.
			{ cwd, env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" } },
		);
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	};
	const config = (value: unknown) =>
		writeFileSync(join(home, "config.json"), JSON.stringify(value));
	return {
		cwd,
		home,
		cli: (...args: string[]) => run("doctor", ...args),
		run,
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
	const finding = report.findings.find(
		(item: { severity: string }) => item.severity === "auto",
	);
	const repaired = JSON.parse(cli("--fix", `kabane/${finding.id}`, "--json"));
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
			expect.objectContaining({ source: "kabane", id: "check-failed" }),
			expect.objectContaining({
				source: "project",
				id: "dispatch-skill-missing",
			}),
		]),
	);
	expect(existsSync(join(home, DB_NAME))).toBe(false);
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
			expect.objectContaining({ id: "store-unavailable", severity: "mention" }),
			expect.objectContaining({ id: "dispatch-skill-missing" }),
		]),
	);
	expect(cli()).toContain("Cannot open the store:");
});

test("a named missing fix is visible even with no findings", () => {
	const { cli } = setup();
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
