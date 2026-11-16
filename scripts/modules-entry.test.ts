import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NotesExtension } from "../packages/cli/src/extension-fixture";
import { modulesEntryFindings } from "./modules-entry";

const homes: string[] = [];
afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});
const fixture = (modules?: string): string => {
	const home = mkdtempSync(join(tmpdir(), "kabane-modules-entry-"));
	homes.push(home);
	return NotesExtension.install(home, modules === undefined ? {} : { modules });
};

it("passes the fixture extension's modules entry, which imports only its table file", () => {
	expect(modulesEntryFindings(fixture())).toEqual([]);
});

it("names a modules entry that reaches the main entry, a board or command file, or a harness client", () => {
	const dir = fixture(
		'import "./table.ts";\nimport "./index.ts";\nimport "./board.tsx";\nimport "@cabane/acp";\n',
	);
	writeFileSync(join(dir, "board.tsx"), 'import "@opentui/react";\n');
	expect(modulesEntryFindings(dir)).toEqual([
		"modules.ts:4: imports @cabane/acp, a board or harness client",
		"index.ts: the extension's main entry",
		"board.tsx: a board or command file",
		"board.tsx:1: imports @opentui/react, a board or harness client",
	]);
});

it("passes every in-repo extension that has a modules entry", () => {
	// recipes names one today; the loop and dispatch are checked here the day theirs do.
	const root = resolve(import.meta.dir, "..");
	const manifests = [
		...new Bun.Glob("extensions/*/package.json").scanSync({
			cwd: root,
			absolute: true,
		}),
	];
	for (const manifest of manifests) {
		const kabane: unknown = JSON.parse(readFileSync(manifest, "utf8")).kabane;
		if (typeof kabane !== "object" || kabane === null || !("modules" in kabane))
			continue;
		expect(modulesEntryFindings(dirname(manifest))).toEqual([]);
	}
});
