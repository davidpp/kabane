import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkLayers as checkWorkspaceLayers, type layers } from "./layers";

// Checker fixtures own their policy; production changes must not change coverage.
const rules = {
	"@kabane/core": {
		layer: "core",
		dependencies: [],
		devDependencies: ["@kabane/sqlite"],
		testSupport: ["packages/core/testing.ts"],
	},
	"@kabane/sqlite": {
		layer: "storage adapter",
		dependencies: ["@kabane/core"],
		devDependencies: [],
	},
	"@kabane/acp": {
		layer: "harness client",
		dependencies: [],
		devDependencies: [],
		exceptions: { "@kabane/board": "fixture: pending port extraction" },
	},
	"@kabane/board": {
		layer: "client",
		dependencies: [],
		devDependencies: ["@kabane/sqlite"],
		testSupport: [
			"packages/board/src/test-db.ts",
			"packages/board/src/stories/fixtures.ts",
			"packages/board/src/stories/index.tsx",
		],
	},
	kabane: {
		layer: "host",
		dependencies: [],
		devDependencies: [],
		testSupport: ["packages/cli/issue-corpus-harness.ts"],
		exceptions: { "@kabane/loop": "fixture: pending loop extraction" },
	},
	"kabane-worker": {
		layer: "hub",
		dependencies: [],
		devDependencies: [],
	},
} satisfies typeof layers;
const checkLayers = (root: string): string[] =>
	checkWorkspaceLayers(root, rules);
const coreExceptionsPolicy = {
	...rules,
	"@kabane/core": {
		...rules["@kabane/core"],
		relativeImports: {
			"packages/core/storage/context-pages.test.ts": {
				"../../cli/issue-corpus-harness": "fixture: pending harness move",
			},
		},
	},
};
const relativeExceptionsPolicy: typeof layers = {
	...coreExceptionsPolicy,
	kabane: {
		...rules.kabane,
		relativeImports: {
			"packages/cli/corpus.test.ts": {
				"../core/issues.json": "fixture: pending fixture entry",
				"../core/manifest.json": "fixture: pending fixture entry",
			},
		},
	},
	"kabane-worker": {
		...rules["kabane-worker"],
		relativeImports: {
			"packages/worker/src/corpus.test.ts": {
				"../../core/issues.json": "fixture: pending fixture entry",
			},
		},
	},
};
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
	dependencies: Record<string, string> = name === "kabane"
		? { "@kabane/loop": "workspace:*" }
		: {},
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
	manifest(root, "packages/core", "@kabane/core", {
		"@kabane/board": "workspace:*",
	});
	expect(checkLayers(root)).toEqual([
		"@kabane/core -> @kabane/board: core dependencies forbids this edge; remove it or revise scripts/layers.ts with an architectural decision.",
	]);
});

test("dev dependencies have a separate allowance", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@kabane/core",
		{},
		{ "@kabane/sqlite": "workspace:*" },
	);
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/core", "@kabane/core", {
		"@kabane/sqlite": "workspace:*",
	});
	expect(checkLayers(root)[0]).toContain("core dependencies forbids this edge");
	manifest(
		root,
		"packages/core",
		"@kabane/core",
		{},
		{ "@kabane/board": "workspace:*" },
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
	manifest(root, "packages/acp", "@kabane/acp", {
		"@kabane/board": "workspace:*",
	});
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/acp", "@kabane/acp");
	expect(checkLayers(root)).toEqual([
		"@kabane/acp -> @kabane/board: stale exception (fixture: pending port extraction); remove this exception from scripts/layers.ts.",
	]);
});

test("the CLI loop exception becomes stale when its runtime dependency is removed", () => {
	const root = workspace();
	manifest(root, "packages/cli", "kabane");
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/cli", "kabane", {});
	expect(checkLayers(root)).toEqual([
		"kabane -> @kabane/loop: stale exception (fixture: pending loop extraction); remove this exception from scripts/layers.ts.",
	]);
});

test("relative cross-package imports fail even when declared, but same-package imports pass", () => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	manifest(root, "packages/sqlite", "@kabane/sqlite", {
		"@kabane/core": "workspace:*",
	});
	write(
		root,
		"packages/sqlite/src/index.ts",
		'import "../local";\nimport type { Db } from "../../core/db";\n',
	);
	expect(checkLayers(root)).toEqual([
		"@kabane/sqlite -> @kabane/core: relative cross-package import ../../core/db in packages/sqlite/src/index.ts:2; use a declared package import instead.",
	]);
});

test.each([
	'import "@kabane/board";',
	'import type { Port } from "@kabane/board/ports";',
	'export { Board } from "@kabane/board";',
	'export type { Port } from "@kabane/board/ports";',
	'const board = import("@kabane/board");',
	'const board = require("@kabane/board");',
	'import board = require("@kabane/board");',
	'type Port = import("@kabane/board/ports").Port;',
])("undeclared imports cannot bypass manifests: %s", (source) => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	write(root, "packages/core/index.ts", source);
	const findings = checkLayers(root);
	expect(findings).toHaveLength(1);
	expect(findings[0]).toContain(
		"@kabane/core -> @kabane/board: undeclared workspace import",
	);
});

test("comments and strings are not imports; tests permit dev dependency subpaths", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@kabane/core",
		{},
		{ "@kabane/sqlite": "workspace:*" },
	);
	write(
		root,
		"packages/core/index.test.ts",
		`
// import "@kabane/board";
const example = 'import "@kabane/board"';
import "@kabane/sqlite/testing";
import "@kabane/core/schemas";
`,
	);
	write(
		root,
		"packages/core/node_modules/vendor/index.ts",
		'import "@kabane/board";',
	);
	write(root, "packages/core/dist/index.js", 'import "@kabane/board";');
	expect(checkLayers(root)).toEqual([]);
});

test("unscoped workspace imports must also be declared", () => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	manifest(root, "packages/cli", "kabane");
	write(root, "packages/core/index.ts", 'import "kabane";');
	expect(checkLayers(root)[0]).toContain(
		"@kabane/core -> kabane: undeclared workspace import",
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
	manifest(root, "packages/core", "@kabane/core");
	manifest(root, "packages/cli", "kabane");
	const file = "packages/core/storage/context-pages.test.ts";
	const specifier = "../../cli/issue-corpus-harness";
	const policy = coreExceptionsPolicy;
	write(root, file, `\n\nimport "${specifier}";`);
	expect(checkWorkspaceLayers(root, policy)).toEqual([]);
	write(root, file, `import "${specifier}";\nimport "../../cli/new";`);
	expect(checkWorkspaceLayers(root, policy)).toEqual([
		"@kabane/core -> kabane: relative cross-package import ../../cli/new in packages/core/storage/context-pages.test.ts:2; use a declared package import instead.",
	]);
	write(root, "packages/core/storage/other.test.ts", `import "${specifier}";`);
	expect(checkWorkspaceLayers(root, policy)).toHaveLength(2);
});

test.each(["removed import", "removed file"])(
	"stale relative exception fails for %s",
	(change) => {
		const root = workspace();
		manifest(root, "packages/core", "@kabane/core");
		manifest(root, "packages/cli", "kabane");
		const file = "packages/core/storage/context-pages.test.ts";
		if (change === "removed import") write(root, file, "export {};");
		expect(checkWorkspaceLayers(root, coreExceptionsPolicy)).toEqual([
			"@kabane/core -> ../../cli/issue-corpus-harness: stale relative import exception in packages/core/storage/context-pages.test.ts (fixture: pending harness move); remove this exception from scripts/layers.ts.",
		]);
	},
);

test("named relative imports across packages pass but an unlisted import fails", () => {
	const root = workspace();
	for (const [path, name] of [
		["packages/core", "@kabane/core"],
		["packages/cli", "kabane"],
		["packages/worker", "kabane-worker"],
	] as const) {
		manifest(root, path, name);
		const rule = relativeExceptionsPolicy[name];
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
	expect(checkWorkspaceLayers(root, relativeExceptionsPolicy)).toEqual([]);
	write(
		root,
		"packages/core/storage/new.test.ts",
		'import "../../cli/issue-corpus-harness";',
	);
	expect(checkWorkspaceLayers(root, relativeExceptionsPolicy)).toEqual([
		"@kabane/core -> kabane: relative cross-package import ../../cli/issue-corpus-harness in packages/core/storage/new.test.ts:1; use a declared package import instead.",
	]);
});

test("production files cannot import dev-only workspace dependencies", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@kabane/core",
		{},
		{ "@kabane/sqlite": "workspace:*" },
	);
	write(root, "packages/core/storage/oplog.ts", 'import "@kabane/sqlite";');
	expect(checkLayers(root)).toEqual([
		"@kabane/core -> @kabane/sqlite: production workspace import @kabane/sqlite in packages/core/storage/oplog.ts:1 is only in devDependencies; declare it in dependencies under the scripts/layers.ts allowance.",
	]);
});

test("relative imports outside every package fail", () => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	write(
		root,
		"packages/core/storage/oplog.ts",
		'import "../../../scripts/layers";',
	);
	expect(checkLayers(root)).toEqual([
		"@kabane/core -> (outside workspace packages): relative cross-package import ../../../scripts/layers in packages/core/storage/oplog.ts:1; use a declared package import instead.",
	]);
});

test.each([
	["packages/core", "@kabane/core", "packages/core/testing.ts"],
	["packages/board", "@kabane/board", "packages/board/src/test-db.ts"],
	["packages/board", "@kabane/board", "packages/board/src/stories/fixtures.ts"],
])(
	"explicit test support in %s permits dev dependencies: %s %s",
	(directory, name, file) => {
		const root = workspace();
		manifest(root, directory, name, {}, { "@kabane/sqlite": "workspace:*" });
		write(root, file, 'import "@kabane/sqlite/testing";');
		expect(checkLayers(root)).toEqual([]);
		write(root, file.replace(".ts", "-other.ts"), 'import "@kabane/sqlite";');
		expect(checkLayers(root)).toHaveLength(1);
	},
);

test.each([
	"../issue-corpus-harness",
	"../issue-corpus-harness.ts",
	"../issue-corpus-harness.js",
	"./../src/../issue-corpus-harness",
])("production files reject their own listed support: %s", (specifier) => {
	const root = workspace();
	manifest(root, "packages/cli", "kabane");
	write(root, "packages/cli/issue-corpus-harness.ts", "export {};");
	write(root, "packages/cli/src/index.test.ts", `import "${specifier}";`);
	expect(checkLayers(root)).toEqual([]);
	write(root, "packages/cli/src/index.ts", `import "${specifier}";`);
	expect(checkLayers(root)).toEqual([
		`kabane -> kabane: production import ${specifier} in packages/cli/src/index.ts:1 uses test support; move it to a test or listed test-support file.`,
	]);
});

test("tests and listed support may import listed support; similar names pass", () => {
	const root = workspace();
	manifest(root, "packages/board", "@kabane/board");
	write(root, "packages/board/src/test-db.ts", "export {};");
	write(root, "packages/board/src/stories/fixtures.ts", 'import "../test-db";');
	write(root, "packages/board/src/index.test.ts", 'import "./test-db";');
	write(root, "packages/board/src/index.ts", 'import "./test-db-other";');
	expect(checkLayers(root)).toEqual([]);
	write(root, "packages/board/src/index.ts", 'import "./test-db";');
	expect(checkLayers(root)).toEqual([
		"@kabane/board -> @kabane/board: production import ./test-db in packages/board/src/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
	write(root, "packages/board/src/stories/index.tsx", "export {};");
	write(root, "packages/board/src/index.ts", 'import "./stories";');
	expect(checkLayers(root)).toEqual([
		"@kabane/board -> @kabane/board: production import ./stories in packages/board/src/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("production imports permit declared runtime dependency subpaths", () => {
	const root = workspace();
	manifest(root, "packages/sqlite", "@kabane/sqlite", {
		"@kabane/core": "workspace:*",
	});
	write(root, "packages/sqlite/index.ts", 'import "@kabane/core/db";');
	expect(checkLayers(root)).toEqual([]);
});

for (const specifier of [
	"@kabane/core/testing",
	"@kabane/core/testing/issue-corpus",
	"@kabane/core/testing/fixtures/issue-corpus/issues.json",
	"@kabane/core/git-fixture",
]) {
	test.each([
		`import "${specifier}";`,
		`import type { Port } from "${specifier}";`,
		`export { Port } from "${specifier}";`,
		`export type { Port } from "${specifier}";`,
		`const support = import("${specifier}");`,
		`const support = require("${specifier}");`,
		`import support = require("${specifier}");`,
		`type Port = import("${specifier}").Port;`,
		`const support = import(\`${specifier}\`);`,
	])("production imports reject core test support: %s", (source) => {
		const root = workspace();
		manifest(root, "packages/sqlite", "@kabane/sqlite", {
			"@kabane/core": "workspace:*",
		});
		write(root, "packages/sqlite/index.ts", `\n${source}`);
		expect(checkLayers(root)).toEqual([
			`@kabane/sqlite -> @kabane/core: production import ${specifier} in packages/sqlite/index.ts:2 uses test support; move it to a test or listed test-support file.`,
		]);
	});
}

test.each([
	"../testing",
	"../testing.ts",
	"../testing.js",
	"../testing/issue-corpus-harness",
	"../storage/../testing/issue-corpus-seed.ts",
	"@kabane/core/testing",
	"../scope/git-fixture",
	"../scope/git-fixture.ts",
	"@kabane/core/git-fixture",
])("core production files reject their own test support: %s", (specifier) => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	write(root, "packages/core/storage/read.ts", `import "${specifier}";`);
	expect(checkLayers(root)).toEqual([
		`@kabane/core -> @kabane/core: production import ${specifier} in packages/core/storage/read.ts:1 uses test support; move it to a test or listed test-support file.`,
	]);
});

test("tests and listed support permit core test support; similar names are production", () => {
	const root = workspace();
	manifest(root, "packages/core", "@kabane/core");
	for (const file of [
		"testing.ts",
		"storage/read.test.ts",
		"storage/read.test.tsx",
	]) {
		write(
			root,
			`packages/core/${file}`,
			'import "@kabane/core/testing";\nimport "./testing/issue-corpus-harness";\nimport "@kabane/core/git-fixture";',
		);
	}
	write(
		root,
		"packages/core/index.ts",
		'import "./testing-other";\nimport "@kabane/core/testing-other";\nimport "@kabane/core/git-fixtures";',
	);
	expect(checkLayers(root)).toEqual([]);
	write(
		root,
		"packages/core/testing-other.ts",
		'import "@kabane/core/testing";',
	);
	expect(checkLayers(root)).toEqual([
		"@kabane/core -> @kabane/core: production import @kabane/core/testing in packages/core/testing-other.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("extension packages enforce the rule and listed support can import subpaths", () => {
	const root = workspace();
	const policy = {
		...rules,
		"@kabane/sample": {
			layer: "extension",
			dependencies: ["@kabane/core"],
			devDependencies: [],
			testSupport: ["extensions/sample/support.ts"],
		},
	};
	manifest(root, "extensions/sample", "@kabane/sample", {
		"@kabane/core": "workspace:*",
	});
	for (const file of ["support.ts", "index.test.ts", "index.ts"]) {
		write(
			root,
			`extensions/sample/${file}`,
			'import "@kabane/core/testing/issue-corpus";',
		);
	}
	expect(checkWorkspaceLayers(root, policy)).toEqual([
		"@kabane/sample -> @kabane/core: production import @kabane/core/testing/issue-corpus in extensions/sample/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("extension production type imports may use declared development dependencies", () => {
	const root = workspace();
	manifest(
		root,
		"extensions/loop",
		"@kabane/loop",
		{},
		{ "@kabane/core": "workspace:*" },
	);
	write(
		root,
		"extensions/loop/index.ts",
		[
			'import type { Task } from "@kabane/core";',
			'export type { Result } from "@kabane/core";',
			'import { type Task as T, type Result as R } from "@kabane/core";',
			'export { type Task as Other } from "@kabane/core";',
		].join("\n"),
	);
	expect(
		checkWorkspaceLayers(root, {
			"@kabane/loop": {
				layer: "extension",
				dependencies: [],
				devDependencies: ["@kabane/core"],
			},
		}),
	).toEqual([]);
});

for (const source of [
	'import { Planner } from "@kabane/core";',
	'import { type Task, Planner } from "@kabane/core";',
	'import Planner, { type Task } from "@kabane/core";',
	'import {} from "@kabane/core";',
	'import "@kabane/core";',
	'export { Planner } from "@kabane/core";',
	'export * from "@kabane/core";',
	'const core = import("@kabane/core");',
]) {
	test(`extension production value import is refused: ${source}`, () => {
		const root = workspace();
		manifest(
			root,
			"extensions/loop",
			"@kabane/loop",
			{},
			{ "@kabane/core": "workspace:*" },
		);
		write(root, "extensions/loop/index.ts", source);
		expect(
			checkWorkspaceLayers(root, {
				"@kabane/loop": {
					layer: "extension",
					dependencies: [],
					devDependencies: ["@kabane/core"],
				},
			}),
		).toEqual([
			"@kabane/loop -> @kabane/core: production workspace import @kabane/core in extensions/loop/index.ts:1 is only in devDependencies; declare it in dependencies under the scripts/layers.ts allowance.",
		]);
	});
}
