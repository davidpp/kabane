import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result, tryCatch, trySync } from "@cabane/core";
import { Kabane } from "./result";
import { Templates } from "./templates";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const copies: string[] = [];
const scratch = (): string => {
	const root = mkdtempSync(join(tmpdir(), "kabane-template-"));
	copies.push(root);
	return root;
};
const copy = (): string => {
	const root = scratch();
	cpSync(Templates.dir("dispatch"), root, { recursive: true });
	return root;
};
const shipped = (): string =>
	unwrap(Templates.hashDir(Templates.dir("dispatch")));

afterEach(() => {
	for (const root of copies.splice(0)) rmSync(root, { recursive: true });
});

describe("Templates.hashDir", () => {
	it("is 12 hex characters, stable, and the same for a copy of the template", () => {
		const hash = shipped();
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
		expect(shipped()).toBe(hash);
		expect(unwrap(Templates.hashDir(copy()))).toBe(hash);
	});

	// The digest base kabane computed before the move (main at e6b8506) for this directory, so a
	// skill stamped then still compares equal.
	it("hashes relative paths and bytes as base kabane did", () => {
		const root = scratch();
		mkdirSync(join(root, "references"));
		writeFileSync(join(root, "SKILL.md"), "skill\n");
		writeFileSync(join(root, "references/a.md"), "a\n");
		writeFileSync(join(root, "PLACEHOLDERS.md"), "ignored\n");
		expect(unwrap(Templates.hashDir(root))).toBe("4c864db59d0b");
	});

	it("changes when a byte of any copied file changes", () => {
		const hash = shipped();
		for (const path of ["SKILL.md", "references/lenses/quality.md"]) {
			const root = copy();
			writeFileSync(join(root, path), "x", { flag: "a" });
			expect(unwrap(Templates.hashDir(root))).not.toBe(hash);
		}
	});

	it("changes when a file is added or renamed", () => {
		const hash = shipped();
		const added = copy();
		writeFileSync(join(added, "references", "extra.md"), "");
		expect(unwrap(Templates.hashDir(added))).not.toBe(hash);
		const renamed = copy();
		cpSync(join(renamed, "SKILL.md"), join(renamed, "SKILL2.md"));
		rmSync(join(renamed, "SKILL.md"));
		expect(unwrap(Templates.hashDir(renamed))).not.toBe(hash);
	});

	it("ignores PLACEHOLDERS.md, which is never copied into a project", () => {
		const root = copy();
		writeFileSync(join(root, "PLACEHOLDERS.md"), "edited", { flag: "a" });
		expect(unwrap(Templates.hashDir(root))).toBe(shipped());
	});

	it("returns an error for a missing template directory", () => {
		const result = Templates.hashDir(
			join(tmpdir(), "kabane-missing-template", "absent"),
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toContain("kabane-missing-template");
	});
});

describe("Templates.stamp", () => {
	it("is dispatch at the shipped template's hash", () => {
		expect(unwrap(Templates.stamp())).toBe(`dispatch@${shipped()}`);
	});
});
