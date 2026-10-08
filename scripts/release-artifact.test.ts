import { afterAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	inspectArchive,
	integrity,
	type ReleaseManifest,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";

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
