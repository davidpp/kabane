import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTemplates } from "./build";

describe("copyTemplates", () => {
	const work = mkdtempSync(join(tmpdir(), "kabane-build-test-"));
	const root = (name: string, templates: readonly string[]): string => {
		const dir = join(work, name);
		for (const template of templates) {
			mkdirSync(join(dir, template), { recursive: true });
			writeFileSync(join(dir, template, "prompt.md"), `${name}/${template}`);
		}
		return dir;
	};

	afterEach(() => rmSync(work, { recursive: true, force: true }));

	it("puts every root's templates side by side under one directory", () => {
		const into = join(work, "dist");
		const copied = copyTemplates(
			[root("acp", ["dispatch"]), root("loop", ["lenses"])],
			into,
		);
		expect(copied.ok && copied.value).toEqual(["dispatch", "lenses"]);
		expect(readFileSync(join(into, "lenses/prompt.md"), "utf8")).toBe(
			"loop/lenses",
		);
	});

	it("fails on a name two roots both ship, before copying either", () => {
		const into = join(work, "dist");
		const copied = copyTemplates(
			[root("loop", ["lenses"]), root("other", ["lenses"])],
			into,
		);
		expect(copied.ok).toBe(false);
		if (!copied.ok) expect(copied.error.message).toContain("templates/lenses");
		expect(existsSync(into)).toBe(false);
	});
});
