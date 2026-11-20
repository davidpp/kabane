import { afterAll, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { DIST } from "./build";
import {
	inspectArchive,
	integrity,
	npmViewSchema,
	PackOutputSchema,
	type ReleaseManifest,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";

const UNEXPECTED_SHAPE = "Unexpected published package file shape.";
const MAP_OR_MACHINE_PATH =
	"Archive exceeds bounds or contains a source map/machine path.";
const DUPLICATE_MEMBER =
	"Archive repeats a member path; no extraction attempted.";
const WORK = mkdtempSync(join(tmpdir(), "kabane-artifact-test-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));
const manifest = {
	name: "kabane",
	version: "1.2.3",
	type: "module",
	bin: { kabane: "bin/kabane.js" },
	engines: { bun: ">=1.4.0" },
	repository: { type: "git", url: "git+https://github.com/davidpp/kabane.git" },
	dependencies: {
		"@opentui/core": "0.5.10",
		"@opentui/react": "0.5.10",
		react: "19.2.3",
	},
};
/** Small self-authored ustar records let regressions exercise traversal/link/size headers. */
const archive = (
	members: { name: string; text: string; type?: number }[],
): Buffer => {
	const blocks: Buffer[] = [];
	for (const member of members) {
		const content = Buffer.from(member.text),
			header = Buffer.alloc(512);
		header.write(member.name);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write("00000000000\0", 136);
		header.fill(32, 148, 156);
		header[156] = member.type ?? 48;
		header.write("ustar\0", 257);
		header.write("00", 263);
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(
			header,
			content,
			Buffer.alloc((512 - (content.length % 512)) % 512),
		);
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};
const normal = [
	{ name: "package/package.json", text: JSON.stringify(manifest) },
	{
		name: "package/bin/kabane.js",
		text: '#!/usr/bin/env bun\nconsole.log("1.2.3")\n',
	},
];
let sequence = 0;
const inspect = async (bytes: Buffer, forbidden: string[] = []) => {
	const dir = join(WORK, String(sequence++));
	mkdirSync(dir);
	const tar = join(dir, "artifact.tgz"),
		unpacked = join(dir, "unpacked");
	writeFileSync(tar, bytes);
	return { result: await inspectArchive(tar, unpacked, forbidden), unpacked };
};
test("ordinary archive validates package identity/bin/engine/exact externals", async () => {
	const result = await inspect(archive(normal));
	expect(result.result.ok).toBe(true);
});
test("named chunks validate alongside the entry and templates", async () => {
	const checked = await inspect(
		archive([
			...normal,
			{
				name: "package/bin/chunk-07j278pm.js",
				text: "export const value = 1;",
			},
			{ name: "package/templates/dispatch/SKILL.md", text: "Dispatch" },
		]),
	);
	expect(checked.result.ok).toBe(true);
});
for (const name of [
	"bin/other.js",
	"bin/chunk-.js",
	"bin/chunk-07j278pm.js.map",
	"bin/nested/chunk-07j278pm.js",
	"chunk-07j278pm.js",
	"src/index.ts",
	"types/other.d.ts",
	"types/nested/extension.d.ts",
	"types/extension.d.ts.map",
])
	test(`unexpected file shape fails: ${name}`, async () => {
		const checked = await inspect(
			archive([...normal, { name: `package/${name}`, text: "unexpected" }]),
		);
		expect(checked.result.ok).toBe(false);
		if (!checked.result.ok)
			expect(checked.result.error.message).toBe(
				name.endsWith(".map") ? MAP_OR_MACHINE_PATH : UNEXPECTED_SHAPE,
			);
	});
test("chunks retain machine-path scanning and cannot replace the entry", async () => {
	const chunk = {
		name: "package/bin/chunk-07j278pm.js",
		text: "FORBIDDEN_BUILD_MACHINE",
	};
	const checked = await inspect(archive([...normal, chunk]), [
		"FORBIDDEN_BUILD_MACHINE",
	]);
	expect(checked.result.ok).toBe(false);
	if (!checked.result.ok)
		expect(checked.result.error.message).toBe(MAP_OR_MACHINE_PATH);
	const missingEntry = await inspect(
		archive([
			...normal.filter((member) => member.name !== "package/bin/kabane.js"),
			chunk,
		]),
	);
	expect(missingEntry.result.ok).toBe(false);
	if (!missingEntry.result.ok)
		expect(missingEntry.result.error.message).toBe(UNEXPECTED_SHAPE);
});
/**
 * npm with a home, cache, logs and user config of its own under WORK, offline: the pack reads
 * nothing from the contributor's npm setup and writes nothing to their home.
 */
const NPM_HOME = join(WORK, "npm-home");
mkdirSync(NPM_HOME);
writeFileSync(join(NPM_HOME, ".npmrc"), "");
const npmEnv = {
	PATH: process.env.PATH,
	HOME: NPM_HOME,
	npm_config_userconfig: join(NPM_HOME, ".npmrc"),
	npm_config_cache: join(NPM_HOME, "cache"),
	npm_config_logs_dir: join(NPM_HOME, "logs"),
	npm_config_offline: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
};
test("npm pack's JSON is read in npm 11's array and npm 12's keyed shape, one kabane archive only", () => {
	const archive = { filename: "kabane-1.2.3.tgz", size: 512 };
	expect(PackOutputSchema.parse([archive])).toEqual([archive]);
	expect(PackOutputSchema.parse({ kabane: archive })).toEqual([archive]);
	for (const refused of [
		[],
		{},
		[archive, archive],
		{ kabane: archive, other: archive },
		[{ ...archive, filename: "other-1.2.3.tgz" }],
		{ kabane: { ...archive, size: 0 } },
	])
		expect(PackOutputSchema.safeParse(refused).success).toBe(false);
});
test("npm view's JSON is read bare (npm 11) or wrapped in one array (npm 12), never a longer array", () => {
	const Version = npmViewSchema(z.string());
	expect(Version.parse("4.6.7")).toBe("4.6.7");
	expect(Version.parse(["4.6.7"])).toBe("4.6.7");
	const Release = npmViewSchema(z.object({ version: z.string() }));
	expect(Release.parse({ version: "4.6.7" })).toEqual({ version: "4.6.7" });
	expect(Release.parse([{ version: "4.6.7" }])).toEqual({ version: "4.6.7" });
	for (const refused of [[], ["4.6.7", "4.6.8"], [["4.6.7"]]])
		expect(Version.safeParse(refused).success).toBe(false);
	expect(
		Release.safeParse([{ version: "4.6.7" }, { version: "4.6.8" }]).success,
	).toBe(false);
});
/** `npm pack` a package directory into a new directory and validate the archive it writes. */
const packBuild = async (packageDir: string) => {
	const dir = join(WORK, String(sequence++));
	mkdirSync(dir);
	const packed = Bun.spawnSync(
		["npm", "pack", "--json", "--pack-destination", dir],
		{ cwd: packageDir, env: npmEnv, stdout: "pipe", stderr: "pipe" },
	);
	if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
	const [first] = PackOutputSchema.parse(JSON.parse(packed.stdout.toString()));
	if (!first) throw new Error("npm pack printed no tarball");
	return inspectArchive(join(dir, first.filename), join(dir, "unpacked"), [
		join(import.meta.dir, ".."),
	]);
};
test("the real build packs into an archive the check admits, and a stray type file is refused", async () => {
	// build() writes only packages/cli/dist; copy it at once so a build running elsewhere
	// cannot change what is packed, and the stray file never lands in the repository.
	// In its own process, so a bundler failure fails only this test.
	const built = Bun.spawnSync([
		process.execPath,
		join(import.meta.dir, "build.ts"),
	]);
	expect(built.stderr.toString()).toBe(`build: ${DIST}\n`);
	expect(built.exitCode).toBe(0);
	const copy = join(WORK, "built");
	cpSync(DIST, copy, { recursive: true });
	const checked = await packBuild(copy);
	if (!checked.ok) throw checked.error;
	expect(checked.value.name).toBe("kabane");
	writeFileSync(join(copy, "types/other.d.ts"), "export {};\n");
	const stray = await packBuild(copy);
	expect(stray.ok).toBe(false);
	if (!stray.ok) expect(stray.error.message).toBe(UNEXPECTED_SHAPE);
}, 120_000);
for (const member of [
	{ name: "package/../../escape", text: "bad" },
	{ name: "/absolute", text: "bad" },
	{ name: "package/link", text: "", type: 50 },
	{ name: "package/hardlink", text: "", type: 49 },
	{ name: "package/pax", text: "", type: 120 },
])
	test(`unsafe archive member refuses extraction: ${member.name}/${member.type ?? 48}`, async () => {
		const checked = await inspect(archive([...normal, member]));
		expect(checked.result.ok).toBe(false);
		expect(existsSync(checked.unpacked)).toBe(false);
	});
for (const name of ["package/types/extension.d.ts", "package/package.json"])
	test(`a member path repeated in the archive refuses extraction: ${name}`, async () => {
		const checked = await inspect(
			archive([
				...normal,
				{ name: "package/types/extension.d.ts", text: "export {};" },
				{ name, text: "{}" },
			]),
		);
		expect(checked.result.ok).toBe(false);
		if (!checked.result.ok)
			expect(checked.result.error.message).toBe(DUPLICATE_MEMBER);
		expect(existsSync(checked.unpacked)).toBe(false);
	});
test("gzip expansion is bounded before extraction", async () => {
	const checked = await inspect(gzipSync(Buffer.alloc(33_554_433)));
	expect(checked.result.ok).toBe(false);
	expect(existsSync(checked.unpacked)).toBe(false);
});
test("manifest identity, private workspace dependency, maps and machine paths fail", async () => {
	for (const members of [
		[
			{
				name: "package/package.json",
				text: JSON.stringify({ ...manifest, name: "other" }),
			},
		],
		[
			{
				name: "package/package.json",
				text: JSON.stringify({
					...manifest,
					peerDependencies: { "@cabane/core": "workspace:*" },
				}),
			},
		],
		[...normal, { name: "package/bin/x.map", text: "{}" }],
		[...normal, { name: "package/README.md", text: "FORBIDDEN_BUILD_MACHINE" }],
	])
		expect(
			(await inspect(archive(members), ["FORBIDDEN_BUILD_MACHINE"])).result.ok,
		).toBe(false);
});

test("release-file byte round trip and source/tag/version/checksum mismatches", () => {
	const dir = join(WORK, "roundtrip");
	mkdirSync(dir);
	const bytes = archive(normal),
		notes = Buffer.from("Reviewed notes\n");
	const record: ReleaseManifest = {
		version: "1.2.3",
		commit: "a".repeat(40),
		tag: "v1.2.3",
		dirty: false,
		filename: "kabane-1.2.3.tgz",
		sha256: sha256(bytes),
		integrity: integrity(bytes),
		notesSha256: sha256(notes),
		bun: "1.4.0",
		npm: "12.2.0",
	};
	const write = (value: ReleaseManifest): void => {
		writeFileSync(join(dir, value.filename), bytes);
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(value));
		writeFileSync(join(dir, "release-notes.md"), notes);
		writeFileSync(
			join(dir, "SHA256SUMS"),
			`${value.sha256}  ${value.filename}\n`,
		);
	};
	write(record);
	expect(verifyReleaseFiles(dir).ok).toBe(true);
	const beta = {
		...record,
		version: "1.2.3-beta.0",
		tag: "v1.2.3-beta.0",
		filename: "kabane-1.2.3-beta.0.tgz",
	};
	write(beta);
	expect(verifyReleaseFiles(dir).ok).toBe(true);
	rmSync(join(dir, beta.filename));
	for (const bad of [
		{ ...beta, tag: "v1.2.3" },
		{
			...beta,
			version: "1.2.3-rc.0",
			tag: "v1.2.3-rc.0",
			filename: "kabane-1.2.3-rc.0.tgz",
		},
	]) {
		write(bad);
		expect(verifyReleaseFiles(dir).ok).toBe(false);
		rmSync(join(dir, bad.filename));
	}
	for (const bad of [
		{ ...record, tag: "v1.2.4" },
		{ ...record, filename: "kabane-1.2.4.tgz" },
		{ ...record, sha256: "b".repeat(64) },
	]) {
		write(bad);
		expect(verifyReleaseFiles(dir).ok).toBe(false);
	}
	write(record);
	writeFileSync(join(dir, record.filename), "corrupted");
	expect(verifyReleaseFiles(dir).ok).toBe(false);
	write(record);
	writeFileSync(join(dir, "release-notes.md"), "changed");
	expect(verifyReleaseFiles(dir).ok).toBe(false);
	write(record);
	rmSync(join(dir, record.filename));
	expect(verifyReleaseFiles(dir).ok).toBe(false);
});
