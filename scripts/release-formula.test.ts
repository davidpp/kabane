import { expect, test } from "bun:test";
import { BinaryTargetSchema, type ReleaseManifest } from "./release-artifact";
import { RELEASES, renderFormula } from "./release-formula";

const record: ReleaseManifest = {
	version: "1.2.3",
	tag: "v1.2.3",
	dirty: false,
	commit: "a".repeat(40),
	notesSha256: "1".repeat(64),
	bun: "1.4.0",
	binaries: BinaryTargetSchema.options.map((target, index) => ({
		target,
		filename: `kabane-${target}.tar.gz`,
		sha256: String(index + 2).repeat(64),
	})),
};

/** The url and sha256 lines of the `on_<os>` / `on_<arch>` block a platform selects. */
const block = (formula: string, os: string, arch: string) => {
	const platform = formula.split(`on_${os} do`)[1]?.split("\n  end")[0] ?? "";
	const body = platform.split(`on_${arch} do`)[1]?.split("end")[0] ?? "";
	return body
		.trim()
		.split("\n")
		.map((line) => line.trim());
};

test("each platform block downloads its own archive and pins that archive's SHA-256", () => {
	const formula = renderFormula(record);
	if (!formula.ok) throw formula.error;
	expect(formula.value).toContain('version "1.2.3"');
	expect(formula.value).not.toContain("{{");
	const at = (target: string) => `${RELEASES}/v1.2.3/kabane-${target}.tar.gz`;
	expect(block(formula.value, "macos", "arm")).toEqual([
		`url "${at("darwin-arm64")}"`,
		`sha256 "${"2".repeat(64)}"`,
	]);
	expect(block(formula.value, "macos", "intel")).toEqual([
		`url "${at("darwin-x64")}"`,
		`sha256 "${"3".repeat(64)}"`,
	]);
	expect(block(formula.value, "linux", "intel")).toEqual([
		`url "${at("linux-x64")}"`,
		`sha256 "${"4".repeat(64)}"`,
	]);
	expect(block(formula.value, "linux", "arm")).toEqual([
		`url "${at("linux-arm64")}"`,
		`sha256 "${"5".repeat(64)}"`,
	]);
});

test("another releases base, such as a loopback server, replaces GitHub's", () => {
	const formula = renderFormula(record, "http://127.0.0.1:8123");
	expect(formula.ok && formula.value).toContain(
		'url "http://127.0.0.1:8123/v1.2.3/kabane-darwin-arm64.tar.gz"',
	);
});

test("a release without binaries, or a template naming an unknown value, has no formula", () => {
	expect(renderFormula({ ...record, binaries: undefined }).ok).toBe(false);
	const unknown = renderFormula(record, RELEASES, 'url "{{url.windows-x64}}"');
	expect(!unknown.ok && unknown.error.message).toContain("url.windows-x64");
});
