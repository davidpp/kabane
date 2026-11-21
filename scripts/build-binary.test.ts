import { afterAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBinary, binaryFilename } from "./build-binary";
import { BinaryTargetSchema, sha256 } from "./release-artifact";

const work = mkdtempSync(join(tmpdir(), "kabane-binary-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test("public target filenames omit the x64 compiler baseline suffix", () => {
	expect(BinaryTargetSchema.options.map(binaryFilename)).toEqual([
		"kabane-darwin-arm64.tar.gz",
		"kabane-darwin-x64.tar.gz",
		"kabane-linux-x64.tar.gz",
		"kabane-linux-arm64.tar.gz",
	]);
});

test("native compile archives executable, an empty templates/, the first-party extensions, docs and checksum; refuses replacement", async () => {
	const target = `${process.platform}-${process.arch}`;
	const output = join(work, "native");
	const result = await buildBinary(target, output);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	const archive = join(output, result.value);
	expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toBe(
		`${sha256(readFileSync(archive))}  ${result.value}\n`,
	);
	const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", work]);
	expect(tar.exitCode).toBe(0);
	const root = join(work, "kabane");
	for (const name of ["kabane", "README.md", "LICENSE"])
		expect(existsSync(join(root, name))).toBe(true);
	// What an older kabane's `update` requires of an extracted release; nothing ships in it.
	expect(readdirSync(join(root, "templates"))).toEqual([]);
	expect(readdirSync(join(root, "extensions")).toSorted()).toEqual([
		"dispatch",
		"jobs",
		"loop",
	]);
	for (const name of ["dispatch", "jobs", "loop"])
		expect(
			JSON.parse(
				readFileSync(join(root, "extensions", name, "package.json"), "utf8"),
			).kabane.extension,
		).toBe("./index.js");
	expect(statSync(join(root, "kabane")).mode & 0o111).not.toBe(0);
	const smoke = Bun.spawnSync(
		[process.execPath, "scripts/smoke.ts", "--binary", join(root, "kabane")],
		{ cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
	);
	expect(smoke.stderr.toString()).toContain("smoke: passed standalone binary");
	expect(smoke.exitCode).toBe(0);
	expect((await buildBinary(target, output)).ok).toBe(false);
}, 120_000);

test("unsupported target cannot create output", async () => {
	const output = join(work, "unsupported");
	expect((await buildBinary("windows-x64", output)).ok).toBe(false);
	expect(existsSync(output)).toBe(false);
});
