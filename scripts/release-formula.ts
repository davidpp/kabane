#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { err, ok, type Result } from "../packages/core/result";
import { type ReleaseManifest, verifyReleaseFiles } from "./release-artifact";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "packaging/homebrew/kabane.rb.tmpl");
export const RELEASES = "https://github.com/davidpp/kabane/releases/download";

/**
 * The Homebrew formula for one release: each platform's archive URL under `releases` and its
 * SHA-256 from the manifest, which `SHA256SUMS` repeats. A release without binaries has none.
 */
export const renderFormula = (
	record: ReleaseManifest,
	releases = RELEASES,
	template = readFileSync(TEMPLATE, "utf8"),
): Result<string> => {
	if (!record.binaries)
		return err(new Error("A release without binaries has no formula."));
	const values = new Map([["version", record.version]]);
	for (const binary of record.binaries) {
		values.set(
			`url.${binary.target}`,
			`${releases}/v${record.version}/${binary.filename}`,
		);
		values.set(`sha256.${binary.target}`, binary.sha256);
	}
	let missing: string | undefined;
	const formula = template.replace(/\{\{([\w.-]+)\}\}/g, (_, key: string) => {
		const value = values.get(key);
		if (value === undefined) missing ??= key;
		return value ?? "";
	});
	return missing === undefined
		? ok(formula)
		: err(new Error(`The formula template names an unknown value: ${missing}`));
};

/** `kabane.rb` written into a verified release directory, beside the archives it names. */
export const writeFormula = (
	directory: string,
	releases = RELEASES,
): Result<string> => {
	const verified = verifyReleaseFiles(directory);
	if (!verified.ok) return verified;
	const formula = renderFormula(verified.value, releases);
	if (!formula.ok) return formula;
	const file = join(directory, "kabane.rb");
	writeFileSync(file, formula.value);
	return ok(file);
};

if (import.meta.main) {
	const [directory, releases, ...extra] = process.argv.slice(2);
	const result =
		directory && !extra.length
			? writeFormula(resolve(directory), releases)
			: err(
					new Error(
						"Usage: bun scripts/release-formula.ts <release-directory> [releases-base-url]",
					),
				);
	if (result.ok) console.error(`formula: ${result.value}`);
	else {
		console.error(result.error.message);
		process.exitCode = 1;
	}
}
