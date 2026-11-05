import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BinaryTargetSchema,
	integrity,
	releaseChecksums,
	sha256,
	verifyReleaseFiles,
	type ReleaseManifest,
} from "./release-artifact";
import { attachBinaries } from "./release-binaries";

// Artifact policy uses arbitrary bytes; build-binary.test.ts exercises the real executable.
const work = mkdtempSync(join(tmpdir(), "kabane-binary-policy-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let sequence = 0;
const artifacts = () => {
	const root = join(work, String(sequence++));
	const directory = join(root, "release");
	const producers = join(root, "producers");
	mkdirSync(directory, { recursive: true });
	const npm = Buffer.from("retained npm archive"),
		notes = Buffer.from("release notes");
	const record: ReleaseManifest = {
		version: "1.2.3",
		tag: "v1.2.3",
		dirty: false,
		commit: "a".repeat(40),
		filename: "kabane-1.2.3.tgz",
		sha256: sha256(npm),
		integrity: integrity(npm),
		notesSha256: sha256(notes),
		bun: "1.4.0",
		npm: "12.2.0",
	};
	writeFileSync(join(directory, record.filename), npm);
	writeFileSync(join(directory, "release-notes.md"), notes);
	writeFileSync(join(directory, "manifest.json"), JSON.stringify(record));
	writeFileSync(join(directory, "SHA256SUMS"), releaseChecksums(record));
	for (const target of BinaryTargetSchema.options) {
		const dir = join(producers, `native-${target}`);
		mkdirSync(dir, { recursive: true });
		const filename = `kabane-${target}.tar.gz`,
			bytes = Buffer.from(target);
		writeFileSync(join(dir, filename), bytes);
		writeFileSync(
			join(dir, `${target}.json`),
			JSON.stringify({
				target,
				filename,
				sha256: sha256(bytes),
				version: record.version,
				commit: record.commit,
				bun: record.bun,
			}),
		);
	}
	return { directory, producers, record };
};

test("assembly retains bytes, hashes every archive, rejects corruption and replacement", () => {
	const { directory, producers } = artifacts();
	expect(attachBinaries(directory, producers).ok).toBe(true);
	const verified = verifyReleaseFiles(directory);
	expect(verified.ok).toBe(true);
	if (!verified.ok) return;
	expect(verified.value.binaries?.length).toBe(4);
	expect(
		readFileSync(join(directory, "SHA256SUMS"), "utf8").trim().split("\n"),
	).toHaveLength(5);
	for (const binary of verified.value.binaries ?? [])
		expect(readFileSync(join(directory, binary.filename))).toEqual(
			readFileSync(join(producers, `native-${binary.target}`, binary.filename)),
		);
	expect(attachBinaries(directory, producers).ok).toBe(false);
	writeFileSync(join(directory, "kabane-linux-x64.tar.gz"), "changed");
	expect(verifyReleaseFiles(directory).ok).toBe(false);
});

for (const mutation of [
	"commit",
	"version",
	"bun",
	"filename",
	"missing",
	"bytes",
])
	test(`assembly refuses ${mutation} mismatch before changing npm manifest`, () => {
		const { directory, producers, record } = artifacts();
		const native = join(producers, "native-linux-arm64");
		const metadata = join(native, "linux-arm64.json");
		if (mutation === "missing") rmSync(metadata);
		else if (mutation === "bytes")
			writeFileSync(join(native, "kabane-linux-arm64.tar.gz"), "changed");
		else {
			const source = JSON.parse(readFileSync(metadata, "utf8")) as Record<
				string,
				unknown
			>;
			source[mutation] =
				mutation === "filename"
					? "../escape"
					: mutation === "commit"
						? "b".repeat(40)
						: "9.9.9";
			writeFileSync(metadata, JSON.stringify(source));
		}
		expect(attachBinaries(directory, producers).ok).toBe(false);
		expect(
			JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
		).toEqual(record);
	});

test("manifest rejects incomplete and duplicate target sets", () => {
	const { directory, producers } = artifacts();
	expect(attachBinaries(directory, producers).ok).toBe(true);
	const verified = verifyReleaseFiles(directory);
	expect(verified.ok).toBe(true);
	if (!verified.ok) return;
	const binaries = verified.value.binaries ?? [];
	for (const invalid of [
		binaries.slice(1),
		[binaries[0], ...binaries.slice(0, 3)],
	]) {
		writeFileSync(
			join(directory, "manifest.json"),
			JSON.stringify({ ...verified.value, binaries: invalid }),
		);
		expect(verifyReleaseFiles(directory).ok).toBe(false);
	}
});
