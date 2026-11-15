import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkLayers as checkWorkspaceLayers, layers } from "./layers";

const rules = Object.fromEntries(
	Object.entries(layers).map(([name, rule]) => [
		name,
		{ ...rule, relativeImports: {} },
	]),
);
const checkLayers = (root: string): string[] =>
	checkWorkspaceLayers(root, rules);
const coreRule = layers["@cabane/core"];
if (!coreRule) throw new Error("Missing core layer rule");
const coreExceptionsPolicy = { ...rules, "@cabane/core": coreRule };
const roots: string[] = [];
function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "kabane-layers-"));
	roots.push(root);
	return root;
}
function write(root: string, path: string, content: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}
function manifest(
	root: string,
	path: string,
	name: string,
	dependencies = {},
	devDependencies = {},
): void {
	write(
		root,
		`${path}/package.json`,
		JSON.stringify({ name, dependencies, devDependencies }),
	);
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("forbidden runtime dependency names the package, rule and remedy", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core", {
		"@cabane/board": "workspace:*",
	});
	expect(checkLayers(root)).toEqual([
		"@cabane/core -> @cabane/board: core dependencies forbids this edge; remove it or revise scripts/layers.ts with an architectural decision.",
	]);
});

test("dev dependencies have a separate allowance", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@cabane/core",
		{},
		{ "@cabane/sqlite": "workspace:*" },
	);
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/core", "@cabane/core", {
		"@cabane/sqlite": "workspace:*",
	});
	expect(checkLayers(root)[0]).toContain("core dependencies forbids this edge");
	manifest(
		root,
		"packages/core",
		"@cabane/core",
		{},
		{ "@cabane/board": "workspace:*" },
	);
	expect(checkLayers(root)[0]).toContain(
		"core devDependencies forbids this edge",
	);
});

test("an unlisted workspace package fails even without workspace dependencies", () => {
	const root = workspace();
	manifest(root, "extensions/new", "new-extension");
	expect(checkLayers(root)).toEqual([
		"new-extension -> (workspace): no layer entry; add its rule to scripts/layers.ts.",
	]);
});

test("named exceptions must still exist in runtime dependencies", () => {
	const root = workspace();
	manifest(root, "packages/acp", "@cabane/acp", {
		"@cabane/board": "workspace:*",
	});
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/acp", "@cabane/acp");
	expect(checkLayers(root)).toEqual([
		"@cabane/acp -> @cabane/board: stale exception (JCAB-320: move UI-neutral ports to the extension contract); remove this exception from scripts/layers.ts.",
	]);
});

test("relative cross-package imports fail even when declared, but same-package imports pass", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	manifest(root, "packages/sqlite", "@cabane/sqlite", {
		"@cabane/core": "workspace:*",
	});
	write(
		root,
		"packages/sqlite/src/index.ts",
		'import "../local";\nimport type { Db } from "../../core/db";\n',
	);
	expect(checkLayers(root)).toEqual([
		"@cabane/sqlite -> @cabane/core: relative cross-package import ../../core/db in packages/sqlite/src/index.ts:2; use a declared package import instead.",
	]);
});

test.each([
	'import "@cabane/board";',
	'import type { Port } from "@cabane/board/ports";',
	'export { Board } from "@cabane/board";',
	'export type { Port } from "@cabane/board/ports";',
	'const board = import("@cabane/board");',
	'const board = require("@cabane/board");',
	'import board = require("@cabane/board");',
	'type Port = import("@cabane/board/ports").Port;',
])("undeclared imports cannot bypass manifests: %s", (source) => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	write(root, "packages/core/index.ts", source);
	const findings = checkLayers(root);
	expect(findings).toHaveLength(1);
	expect(findings[0]).toContain(
		"@cabane/core -> @cabane/board: undeclared workspace import",
	);
});

test("comments and strings are not imports; dependencies and dev dependencies permit subpaths", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@cabane/core",
		{},
		{ "@cabane/sqlite": "workspace:*" },
	);
	write(
		root,
		"packages/core/index.ts",
		`
// import "@cabane/board";
const example = 'import "@cabane/board"';
import "@cabane/sqlite/testing";
import "@cabane/core/schemas";
`,
	);
	write(
		root,
		"packages/core/node_modules/vendor/index.ts",
		'import "@cabane/board";',
	);
	write(root, "packages/core/dist/index.js", 'import "@cabane/board";');
	expect(checkLayers(root)).toEqual([]);
});

test("unscoped workspace imports must also be declared", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	manifest(root, "packages/cli", "kabane");
	write(root, "packages/core/index.ts", 'import "kabane";');
	expect(checkLayers(root)[0]).toContain(
		"@cabane/core -> kabane: undeclared workspace import",
	);
});

test("invalid manifests fail closed", () => {
	const root = workspace();
	write(root, "packages/core/package.json", '{"name": 42}');
	expect(checkLayers(root)[0]).toContain(
		"invalid package name or dependencies",
	);
	write(root, "packages/core/package.json", "{");
	expect(checkLayers(root)[0]).toContain("(scan)");
});

test("today's workspace tree passes", () => {
	expect(checkWorkspaceLayers(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("relative exceptions match file and specifier, survive line shifts, and reject new imports", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	manifest(root, "packages/cli", "kabane");
	const file = "packages/core/storage/context-pages.test.ts";
	const specifier = "../../cli/issue-corpus-harness";
	const policy = coreExceptionsPolicy;
	write(root, file, `\n\nimport "${specifier}";`);
	expect(checkWorkspaceLayers(root, policy)).toEqual([]);
	write(root, file, `import "${specifier}";\nimport "../../cli/new";`);
	expect(checkWorkspaceLayers(root, policy)).toEqual([
		"@cabane/core -> kabane: relative cross-package import ../../cli/new in packages/core/storage/context-pages.test.ts:2; use a declared package import instead.",
	]);
	write(
		root,
		"packages/core/other.ts",
		`import "../cli/issue-corpus-harness";`,
	);
	expect(checkWorkspaceLayers(root, policy)).toHaveLength(2);
});

test.each(["removed import", "removed file"])(
	"stale relative exception fails for %s",
	(change) => {
		const root = workspace();
		manifest(root, "packages/core", "@cabane/core");
		manifest(root, "packages/cli", "kabane");
		const file = "packages/core/storage/context-pages.test.ts";
		if (change === "removed import") write(root, file, "export {};");
		expect(checkWorkspaceLayers(root, coreExceptionsPolicy)).toEqual([
			"@cabane/core -> ../../cli/issue-corpus-harness: stale relative import exception in packages/core/storage/context-pages.test.ts (JCAB-331: replace relative cross-package imports); remove this exception from scripts/layers.ts.",
		]);
	},
);

test("the nine named relative imports pass but a tenth fails", () => {
	const root = workspace();
	for (const [path, name] of [
		["packages/core", "@cabane/core"],
		["packages/cli", "kabane"],
		["packages/worker", "cabane-worker"],
	] as const) {
		manifest(root, path, name);
		const rule = layers[name];
		for (const [file, imports] of Object.entries(rule?.relativeImports ?? {})) {
			write(
				root,
				file,
				Object.keys(imports)
					.map((specifier) => `import "${specifier}";`)
					.join("\n"),
			);
		}
	}
	expect(checkWorkspaceLayers(root)).toEqual([]);
	write(
		root,
		"packages/core/storage/new.test.ts",
		'import "../../cli/issue-corpus-harness";',
	);
	expect(checkWorkspaceLayers(root)).toEqual([
		"@cabane/core -> kabane: relative cross-package import ../../cli/issue-corpus-harness in packages/core/storage/new.test.ts:1; use a declared package import instead.",
	]);
});
