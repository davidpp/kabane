import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
const ROOT = resolve(import.meta.dir, "../../../..");
const DIST = join(ROOT, "packages/cli/dist");
import {
	createUpdateFixture,
	UPDATE_SOURCE,
	UPDATE_TARGET,
	updateSnapshot,
} from "../update-fixture";
import { runUpdateProcess } from "../update-process";

const WORK = mkdtempSync(join(tmpdir(), "kabane-update-archive-"));
const BETA = `${Number(UPDATE_SOURCE.split(".")[0]) + 1}.0.0-beta.0`,
	NEXT_BETA = BETA.replace(/0$/, "1"),
	BETA_RELEASE = BETA.replace(/-.*/, "");
let archive = "",
	betaArchive = "";
/**
 * The packed CLI at another version: its manifest and the one version literal the bundle inlines
 * from it. The shared dist is built once, so a second build at a beta version is not an option.
 */
const repack = (from: string, version: string): string => {
	const dir = join(WORK, `repack-${version}`);
	mkdirSync(dir);
	expect(Bun.spawnSync(["tar", "-xzf", from, "-C", dir]).exitCode).toBe(0);
	const manifest = join(dir, "package/package.json"),
		bundle = join(dir, "package/bin/kabane.js");
	writeFileSync(
		manifest,
		JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }),
	);
	const text = readFileSync(bundle, "utf8"),
		literal = JSON.stringify(UPDATE_SOURCE);
	expect(text.split(literal)).toHaveLength(2);
	writeFileSync(bundle, text.replace(literal, JSON.stringify(version)));
	const out = join(WORK, `kabane-${version}.tgz`);
	expect(
		Bun.spawnSync(["tar", "-czf", out, "package"], { cwd: dir }).exitCode,
	).toBe(0);
	return out;
};
beforeAll(async () => {
	const built = Bun.spawnSync([process.execPath, "scripts/build.ts"], {
		cwd: ROOT,
	});
	expect(built.exitCode).toBe(0);
	const packed = Bun.spawnSync(
		["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", WORK],
		{ cwd: DIST },
	);
	expect(packed.exitCode).toBe(0);
	const parsed = z
		.array(z.object({ filename: z.string() }))
		.safeParse(JSON.parse(packed.stdout.toString()));
	if (!parsed.success || !parsed.data[0]) return;
	archive = join(WORK, parsed.data[0].filename);
	betaArchive = repack(archive, BETA);
}, 30_000);
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

for (const configured of [false, true])
	test(`packed CLI metadata-only candidate and exact verified update (configured=${configured})`, async () => {
		const fixture = await createUpdateFixture(archive, { configured });
		if (!fixture.ok) return expect(fixture.error).toBe("");
		try {
			const before = updateSnapshot(fixture.install),
				tracker = updateSnapshot(fixture.tracker);
			fixture.requests.length = 0;
			const checked = await fixture.run(["update", "--check", "--json"]);
			expect(checked.value).toMatchObject({ code: 0 });
			expect(checked.ok && JSON.parse(checked.value.stdout)).toMatchObject({
				status: "candidate",
				eligibility: "unknown",
				candidateVersion: UPDATE_TARGET,
			});
			expect(fixture.requests.every((path) => path === "/kabane")).toBe(true);
			expect(updateSnapshot(fixture.install)).toEqual(before);
			const changed = await fixture.run(["update", "--json"]);
			expect(changed.ok && changed.value.code).toBe(0);
			expect(changed.ok && JSON.parse(changed.value.stdout)).toMatchObject({
				status: "updated",
				eligibility: "bun_preflight_passed",
				restartRequired: true,
			});
			expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
			const printed = await runUpdateProcess(
				[process.execPath, fixture.bin, "--version"],
				fixture.home,
				fixture.env,
			);
			expect(printed.ok && printed.value.stdout.trim()).toBe(UPDATE_TARGET);
		} finally {
			fixture.close();
		}
	}, 30_000);

test("young candidate remains policy-unverified; actual age preflight blocks without install changes", async () => {
	const fixture = await createUpdateFixture(archive, {
		age: 86400,
		young: true,
	});
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		const before = updateSnapshot(fixture.install),
			tracker = updateSnapshot(fixture.tracker);
		const checked = await fixture.run(["update", "--check", "--json"]);
		expect(checked.ok && JSON.parse(checked.value.stdout)).toMatchObject({
			status: "candidate",
			eligibility: "unknown",
		});
		const attempted = await fixture.run(["update", "--json"]);
		expect(attempted.ok && attempted.value.code).toBe(1);
		expect(attempted.ok && JSON.parse(attempted.value.stderr)).toMatchObject({
			status: "blocked",
			eligibility: "unknown",
		});
		expect(updateSnapshot(fixture.install)).toEqual(before);
		expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
		expect(fixture.requests).not.toContain(
			`/kabane/-/kabane-${UPDATE_TARGET}.tgz`,
		);
	} finally {
		fixture.close();
	}
}, 30_000);

test("fresh isolated global registration and exact manager update never imply an owned global bin", async () => {
	const fixture = await createUpdateFixture(archive, { isolated: true });
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		if (Bun.version === "1.4.0") expect(existsSync(fixture.bin)).toBe(false);
		// Keep this fail-closed case deterministic if a newer Bun fixes bin creation.
		rmSync(fixture.bin, { force: true });
		for (const args of [["update", "--check"], ["update"]]) {
			const before = updateSnapshot(fixture.install),
				tracker = updateSnapshot(fixture.tracker);
			fixture.requests.length = 0;
			const refused = await fixture.run(args);
			expect(refused.ok && refused.value.code).toBe(1);
			expect(fixture.requests).toEqual([]);
			expect(updateSnapshot(fixture.install)).toEqual(before);
			expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
		}
		const manager = await runUpdateProcess(
			[
				process.execPath,
				"add",
				"--global",
				"--exact",
				`kabane@${UPDATE_TARGET}`,
			],
			fixture.home,
			fixture.env,
		);
		expect(manager.ok && manager.value.code).toBe(0);
		if (Bun.version === "1.4.0") expect(existsSync(fixture.bin)).toBe(false);
		fixture.copyBundle();
		const before = updateSnapshot(fixture.install);
		fixture.requests.length = 0;
		const refused = await fixture.run(["update", "--check"]);
		expect(refused.ok && refused.value.code).toBe(1);
		// The refusal itself, not just exit 1: a bundle copied without its chunks also exits 1.
		expect(refused.ok && refused.value.stderr).toContain(
			"Unsupported installation",
		);
		expect(fixture.requests).toEqual([]);
		expect(updateSnapshot(fixture.install)).toEqual(before);
	} finally {
		fixture.close();
	}
}, 30_000);

test("source link refuses check and update without network, tracker writes or link replacement", async () => {
	const fixture = await createUpdateFixture(archive);
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		const slot = join(fixture.globalDir, "node_modules/kabane"),
			source = join(fixture.work, "source");
		mkdirSync(source);
		Bun.spawnSync(["cp", "-R", `${slot}/.`, source]);
		symlinkSync(
			join(fixture.globalDir, "node_modules"),
			join(source, "node_modules"),
			"dir",
		);
		const linked = await runUpdateProcess(
			[process.execPath, "link"],
			source,
			fixture.env,
		);
		expect(linked.ok && linked.value.code).toBe(0);
		const before = updateSnapshot(fixture.install),
			tracker = updateSnapshot(fixture.tracker),
			sourceBefore = updateSnapshot(source);
		fixture.requests.length = 0;
		for (const args of [["update", "--check"], ["update"]]) {
			const refused = await fixture.run(args);
			expect(refused.ok && refused.value.code).toBe(1);
		}
		expect(fixture.requests).toEqual([]);
		expect(updateSnapshot(fixture.install)).toEqual(before);
		expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
		expect(updateSnapshot(source)).toEqual(sourceBefore);
	} finally {
		fixture.close();
	}
}, 30_000);

test("real manager nonzero after trusted postinstall is an honest partial failure", async () => {
	const fixture = await createUpdateFixture(archive, { failScript: true });
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		const file = join(fixture.globalDir, "package.json");
		writeFileSync(
			file,
			JSON.stringify({
				dependencies: { kabane: UPDATE_SOURCE },
				trustedDependencies: ["kabane"],
			}),
		);
		const before = updateSnapshot(fixture.install),
			tracker = updateSnapshot(fixture.tracker);
		const preflight = await runUpdateProcess(
			[
				process.execPath,
				"add",
				"--global",
				"--exact",
				`kabane@${UPDATE_TARGET}`,
				"--dry-run",
			],
			fixture.globalDir,
			fixture.env,
		);
		expect(preflight.ok && preflight.value.code).toBe(0);
		expect(updateSnapshot(fixture.install)).toEqual(before);
		const attempted = await fixture.run(["update", "--json"]);
		expect(attempted.ok && attempted.value.code).toBe(1);
		expect(attempted.ok && JSON.parse(attempted.value.stderr)).toMatchObject({
			status: "partial_failure",
			possiblePartialChange: true,
		});
		expect(updateSnapshot(fixture.install)).not.toEqual(before);
		expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
	} finally {
		fixture.close();
	}
}, 30_000);

test("metadata current/manual policies/malformed/offline never mutate installation or tracker", async () => {
	const sourceParts = UPDATE_SOURCE.split(".").map(Number);
	for (const [version, engine, status] of [
		[UPDATE_SOURCE, ">=1.4.0", "current"],
		[`${(sourceParts[0] ?? 0) + 1}.0.0`, ">=1.4.0", "manual_only"],
		[UPDATE_TARGET, ">=999.0.0", "manual_only"],
		[`${UPDATE_TARGET}-next.1`, ">=1.4.0", "manual_only"],
		["invalid-version", ">=1.4.0", "error"],
	]) {
		const fixture = await createUpdateFixture(archive);
		if (!fixture.ok) return expect(fixture.error).toBe("");
		try {
			if (!version || !engine || !status) continue;
			fixture.setDistTags({ latest: version }, engine);
			const before = updateSnapshot(fixture.install),
				tracker = updateSnapshot(fixture.tracker),
				home = updateSnapshot(fixture.home);
			const checked = await fixture.run(["update", "--check", "--json"]);
			const printed: unknown = JSON.parse(
				checked.value.code === 0 ? checked.value.stdout : checked.value.stderr,
			);
			expect(printed).toMatchObject({ status, eligibility: "unknown" });
			expect(updateSnapshot(fixture.install)).toEqual(before);
			expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
			expect(updateSnapshot(fixture.home)).toEqual(home);
		} finally {
			fixture.close();
		}
	}
	const offline = await createUpdateFixture(archive);
	if (!offline.ok) return expect(offline.error).toBe("");
	try {
		const before = updateSnapshot(offline.install),
			tracker = updateSnapshot(offline.tracker);
		offline.stopRegistry();
		const checked = await offline.run(["update", "--check", "--json"]);
		expect(checked.value.code).toBe(1);
		expect(JSON.parse(checked.value.stderr)).toMatchObject({
			status: "error",
			eligibility: "unknown",
		});
		expect(updateSnapshot(offline.install)).toEqual(before);
		expect(updateSnapshot(offline.tracker)).toEqual(tracker);
	} finally {
		offline.close();
	}
}, 30_000);

test("real manager removes global bin: nonzero partial result, never repair or success", async () => {
	const fixture = await createUpdateFixture(archive, { removeBin: true });
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		writeFileSync(
			join(fixture.globalDir, "package.json"),
			JSON.stringify({
				dependencies: { kabane: UPDATE_SOURCE },
				trustedDependencies: ["kabane"],
			}),
		);
		const tracker = updateSnapshot(fixture.tracker);
		const attempted = await fixture.run(["update", "--json"]);
		expect(attempted.value.code).toBe(1);
		expect(JSON.parse(attempted.value.stderr)).toMatchObject({
			status: "partial_failure",
			possiblePartialChange: true,
		});
		expect(existsSync(fixture.bin)).toBe(false);
		expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
	} finally {
		fixture.close();
	}
}, 30_000);

test("configured Bun dryRun refuses mutation rather than relying on manager config interpretation", async () => {
	const fixture = await createUpdateFixture(archive);
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		writeFileSync(
			join(fixture.home, ".bunfig.toml"),
			`${readFileSync(join(fixture.home, ".bunfig.toml"), "utf8")}dryRun = true\n`,
		);
		const before = updateSnapshot(fixture.install);
		const attempted = await fixture.run(["update", "--json"]);
		expect(attempted.value.code).toBe(1);
		expect(JSON.parse(attempted.value.stderr)).toMatchObject({
			status: "blocked",
			eligibility: "unknown",
		});
		expect(updateSnapshot(fixture.install)).toEqual(before);
	} finally {
		fixture.close();
	}
}, 30_000);

test("invalid arguments dispatch standalone without tracker or metadata access", async () => {
	const fixture = await createUpdateFixture(archive);
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		const before = updateSnapshot(fixture.tracker);
		fixture.requests.length = 0;
		const reply = await fixture.run(["update", "--force", "--json"]);
		expect(reply.value.code).toBe(2);
		expect(fixture.requests).toEqual([]);
		expect(updateSnapshot(fixture.tracker)).toEqual(before);
	} finally {
		fixture.close();
	}
}, 30_000);

test("a beta install follows the higher of beta and latest, up to the stable release it precedes", async () => {
	const fixture = await createUpdateFixture(betaArchive, {
		source: BETA,
		target: NEXT_BETA,
	});
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		const printed = await fixture.run(["--version"]);
		expect(printed.value.stdout.trim()).toBe(BETA);
		const tracker = updateSnapshot(fixture.tracker);
		for (const [tags, expected] of [
			// No beta tag, and an older latest is not a downgrade offer.
			[{ latest: "0.1.0" }, { status: "current" }],
			[{ latest: "0.1.0", beta: BETA }, { status: "current" }],
			// Every version a prerelease and no beta tag: Bun cannot resolve `kabane@beta` here.
			[
				{ latest: NEXT_BETA },
				{ status: "candidate", candidateVersion: NEXT_BETA },
			],
			[
				{ latest: "0.1.0", beta: NEXT_BETA },
				{ status: "candidate", candidateVersion: NEXT_BETA },
			],
			[
				{ latest: BETA_RELEASE, beta: BETA },
				{ status: "candidate", candidateVersion: BETA_RELEASE },
			],
			[
				{ latest: "0.1.0", beta: `${BETA_RELEASE}-rc.1` },
				{ status: "manual_only" },
			],
		] as const) {
			fixture.setDistTags(tags);
			const before = updateSnapshot(fixture.install);
			const checked = await fixture.run(["update", "--check", "--json"]);
			expect(checked.value.code).toBe(0);
			expect(JSON.parse(checked.value.stdout)).toMatchObject({
				...expected,
				eligibility: "unknown",
			});
			expect(updateSnapshot(fixture.install)).toEqual(before);
		}
		fixture.setDistTags({ latest: "0.1.0", beta: NEXT_BETA });
		const changed = await fixture.run(["update", "--json"]);
		expect(changed.value.code).toBe(0);
		expect(JSON.parse(changed.value.stdout)).toMatchObject({
			status: "updated",
			candidateVersion: NEXT_BETA,
		});
		const after = await runUpdateProcess(
			[process.execPath, fixture.bin, "--version"],
			fixture.home,
			fixture.env,
		);
		expect(after.ok && after.value.stdout.trim()).toBe(NEXT_BETA);
		expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
	} finally {
		fixture.close();
	}
}, 30_000);

test("the documented `bun add -g kabane@beta` registration is a supported install", async () => {
	const fixture = await createUpdateFixture(betaArchive, {
		source: BETA,
		target: NEXT_BETA,
	});
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		fixture.setDistTags({ latest: "0.1.0", beta: BETA });
		// --no-cache: Bun would otherwise resolve the tag from the manifest it cached at the first install.
		const installed = await runUpdateProcess(
			[process.execPath, "add", "--global", "--no-cache", "kabane@beta"],
			fixture.home,
			fixture.env,
		);
		expect(installed.ok && installed.value.code).toBe(0);
		expect(
			JSON.parse(readFileSync(join(fixture.globalDir, "package.json"), "utf8")),
		).toEqual({ dependencies: { kabane: `^${BETA}` } });
		const checked = await fixture.run(["update", "--check", "--json"]);
		expect(checked.value.code).toBe(0);
		expect(JSON.parse(checked.value.stdout)).toMatchObject({
			status: "current",
			installedVersion: BETA,
		});
	} finally {
		fixture.close();
	}
}, 30_000);
