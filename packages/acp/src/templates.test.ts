import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Result } from "@cabane/core";
import { Templates } from "./templates";
const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const copies: string[] = [];
const copy = (): string => {
	const root = mkdtempSync(join(tmpdir(), "kabane-template-"));
	copies.push(root);
	cpSync(Templates.dir("dispatch"), root, { recursive: true });
	return root;
};

afterEach(() => {
	for (const root of copies.splice(0)) rmSync(root, { recursive: true });
});

describe("Templates.hash", () => {
	it("is 12 hex characters, stable, and the same for a copy of the template", () => {
		const hash = unwrap(Templates.hash("dispatch"));
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
		expect(unwrap(Templates.hash("dispatch"))).toBe(hash);
		expect(unwrap(Templates.hashDir(copy()))).toBe(hash);
	});

	it("changes when a byte of any copied file changes", () => {
		const hash = unwrap(Templates.hash("dispatch"));
		for (const path of ["SKILL.md", "references/lenses/quality.md"]) {
			const root = copy();
			const file = join(root, path);
			writeFileSync(file, "x", { flag: "a" });
			expect(unwrap(Templates.hashDir(root))).not.toBe(hash);
		}
	});

	it("changes when a file is added or renamed", () => {
		const hash = unwrap(Templates.hash("dispatch"));
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
		expect(unwrap(Templates.hashDir(root))).toBe(
			unwrap(Templates.hash("dispatch")),
		);
	});
});

describe("Templates.stamp", () => {
	it("is the template's name at its hash", () => {
		expect(unwrap(Templates.stamp("dispatch"))).toBe(
			`dispatch@${unwrap(Templates.hash("dispatch"))}`,
		);
	});
});

it("returns an error for a missing template directory", () => {
	const result = Templates.hashDir(
		join(tmpdir(), "kabane-missing-template", "absent"),
	);
	expect(result.ok).toBe(false);
	if (!result.ok)
		expect(result.error.message).toContain("kabane-missing-template");
	expect(Templates.stamp("absent-template").ok).toBe(false);
});
