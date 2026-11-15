import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Templates } from "./templates";

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
		const hash = Templates.hash("dispatch");
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
		expect(Templates.hash("dispatch")).toBe(hash);
		expect(Templates.hashDir(copy())).toBe(hash);
	});

	it("changes when a byte of any copied file changes", () => {
		const hash = Templates.hash("dispatch");
		for (const path of ["SKILL.md", "references/lenses/quality.md"]) {
			const root = copy();
			const file = join(root, path);
			writeFileSync(file, "x", { flag: "a" });
			expect(Templates.hashDir(root)).not.toBe(hash);
		}
	});

	it("changes when a file is added or renamed", () => {
		const hash = Templates.hash("dispatch");
		const added = copy();
		writeFileSync(join(added, "references", "extra.md"), "");
		expect(Templates.hashDir(added)).not.toBe(hash);
		const renamed = copy();
		cpSync(join(renamed, "SKILL.md"), join(renamed, "SKILL2.md"));
		rmSync(join(renamed, "SKILL.md"));
		expect(Templates.hashDir(renamed)).not.toBe(hash);
	});

	it("ignores PLACEHOLDERS.md, which is never copied into a project", () => {
		const root = copy();
		writeFileSync(join(root, "PLACEHOLDERS.md"), "edited", { flag: "a" });
		expect(Templates.hashDir(root)).toBe(Templates.hash("dispatch"));
	});
});

describe("Templates.stamp", () => {
	it("is the template's name at its hash", () => {
		expect(Templates.stamp("dispatch")).toBe(
			`dispatch@${Templates.hash("dispatch")}`,
		);
	});
});
