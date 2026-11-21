import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
	updateSnapshot,
} from "../update-fixture";
import { runUpdateProcess } from "../update-process";

const WORK = mkdtempSync(join(tmpdir(), "kabane-update-archive-"));
const BETA = `${Number(UPDATE_SOURCE.split(".")[0]) + 1}.0.0-beta.0`,
	NEXT_BETA = BETA.replace(/0$/, "1");
let archive = "",
	betaArchive = "";
/**
 * The packed CLI at another version: its manifest and the one version literal the bundle inlines
 * from it, in whichever of `bin/`'s files the build split it into (the entry, or a chunk the entry
 * shares with a lazy command). The shared dist is built once, so a second build at a beta version
 * is not an option.
 */
const repack = (from: string, version: string): string => {
	const dir = join(WORK, `repack-${version}`);
	mkdirSync(dir);
	expect(Bun.spawnSync(["tar", "-xzf", from, "-C", dir]).exitCode).toBe(0);
	const manifest = join(dir, "package/package.json"),
		bin = join(dir, "package/bin");
	writeFileSync(
		manifest,
		JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }),
	);
	const literal = JSON.stringify(UPDATE_SOURCE);
	const holding = readdirSync(bin)
		.map((name) => join(bin, name))
		.filter((file) => readFileSync(file, "utf8").includes(literal));
	expect(holding).toHaveLength(1);
	const [bundle = ""] = holding;
	const text = readFileSync(bundle, "utf8");
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
	// npm 11 prints an array of results, npm 12 an object keyed by package name.
	const Packed = z.object({ filename: z.string() });
	const [first] = z
		.union([
			z.array(Packed),
			z.record(z.string(), Packed).transform((byName) => Object.values(byName)),
		])
		.parse(JSON.parse(packed.stdout.toString()));
	if (!first) throw new Error("npm pack printed no archive");
	archive = join(WORK, first.filename);
	betaArchive = repack(archive, BETA);
}, 120_000);
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

/** What a Bun install hears from either command: the way to a GitHub-release install. */
const expectMoved = (
	reply: { code: number; stdout: string; stderr: string },
	code: 0 | 1,
	version: string,
) => {
	expect(reply.code).toBe(code);
	expect(JSON.parse(code === 0 ? reply.stdout : reply.stderr)).toMatchObject({
		status: "moved",
		installedVersion: version,
		install: "bun",
	});
};

for (const configured of [false, true])
	test(`a Bun global install is told releases moved to GitHub, with nothing read or changed (configured=${configured})`, async () => {
		const fixture = await createUpdateFixture(archive, { configured });
		if (!fixture.ok) return expect(fixture.error).toBe("");
		try {
			const before = updateSnapshot(fixture.install),
				tracker = updateSnapshot(fixture.tracker);
			fixture.requests.length = 0;
			expectMoved(
				(await fixture.run(["update", "--check", "--json"])).value,
				0,
				UPDATE_SOURCE,
			);
			expectMoved(
				(await fixture.run(["update", "--json"])).value,
				1,
				UPDATE_SOURCE,
			);
			const text = await fixture.run(["update"]);
			expect(text.value.stderr).toContain(
				"kabane releases moved from npm to GitHub Releases",
			);
			expect(text.value.stderr).toContain("brew install davidpp/tap/kabane");
			expect(text.value.stderr).toContain(
				"curl -fsSL https://github.com/davidpp/kabane/releases/latest/download/install.sh | sh",
			);
			expect(fixture.requests).toEqual([]);
			expect(updateSnapshot(fixture.install)).toEqual(before);
			expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
		} finally {
			fixture.close();
		}
	}, 30_000);

test("an isolated global registration is no owned global bin and is refused", async () => {
	const fixture = await createUpdateFixture(archive, { isolated: true });
	if (!fixture.ok) return expect(fixture.error).toBe("");
	try {
		// Keep this fail-closed case deterministic if a newer Bun creates the bin.
		rmSync(fixture.bin, { force: true });
		for (const args of [["update", "--check"], ["update"]]) {
			const before = updateSnapshot(fixture.install),
				tracker = updateSnapshot(fixture.tracker);
			fixture.requests.length = 0;
			const refused = await fixture.run(args);
			expect(refused.value.code).toBe(1);
			expect(refused.value.stderr).toContain("Unsupported installation");
			expect(fixture.requests).toEqual([]);
			expect(updateSnapshot(fixture.install)).toEqual(before);
			expect(updateSnapshot(fixture.tracker)).toEqual(tracker);
		}
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

test("the documented `bun add -g kabane@beta` registration is told releases moved too", async () => {
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
		expectMoved(
			(await fixture.run(["update", "--check", "--json"])).value,
			0,
			BETA,
		);
	} finally {
		fixture.close();
	}
}, 30_000);
