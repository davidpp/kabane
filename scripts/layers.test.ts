import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkLayers as checkWorkspaceLayers, type layers } from "./layers";

// Checker fixtures own their policy; production changes must not change coverage.
const rules = {
	"@cabane/core": {
		layer: "core",
		dependencies: [],
		devDependencies: ["@cabane/sqlite"],
		testSupport: ["packages/core/testing.ts"],
	},
	"@cabane/sqlite": {
		layer: "storage adapter",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/acp": {
		layer: "harness client",
		dependencies: [],
		devDependencies: [],
		exceptions: { "@cabane/board": "fixture: pending port extraction" },
	},
	"@cabane/board": {
		layer: "client",
		dependencies: [],
		devDependencies: ["@cabane/sqlite"],
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
		exceptions: { "@cabane/loop": "fixture: pending loop extraction" },
	},
	"cabane-worker": {
		layer: "hub",
		dependencies: [],
		devDependencies: [],
	},
} satisfies typeof layers;
const checkLayers = (root: string): string[] =>
	checkWorkspaceLayers(root, rules);
const coreExceptionsPolicy = {
	...rules,
	"@cabane/core": {
		...rules["@cabane/core"],
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
	"cabane-worker": {
		...rules["cabane-worker"],
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
		? { "@cabane/loop": "workspace:*" }
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
		"@cabane/acp -> @cabane/board: stale exception (fixture: pending port extraction); remove this exception from scripts/layers.ts.",
	]);
});

test("the CLI loop exception becomes stale when its runtime dependency is removed", () => {
	const root = workspace();
	manifest(root, "packages/cli", "kabane");
	expect(checkLayers(root)).toEqual([]);
	manifest(root, "packages/cli", "kabane", {});
	expect(checkLayers(root)).toEqual([
		"kabane -> @cabane/loop: stale exception (fixture: pending loop extraction); remove this exception from scripts/layers.ts.",
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

test("comments and strings are not imports; tests permit dev dependency subpaths", () => {
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
		"packages/core/index.test.ts",
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
	write(root, "packages/core/storage/other.test.ts", `import "${specifier}";`);
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
			"@cabane/core -> ../../cli/issue-corpus-harness: stale relative import exception in packages/core/storage/context-pages.test.ts (fixture: pending harness move); remove this exception from scripts/layers.ts.",
		]);
	},
);

test("named relative imports across packages pass but an unlisted import fails", () => {
	const root = workspace();
	for (const [path, name] of [
		["packages/core", "@cabane/core"],
		["packages/cli", "kabane"],
		["packages/worker", "cabane-worker"],
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
		"@cabane/core -> kabane: relative cross-package import ../../cli/issue-corpus-harness in packages/core/storage/new.test.ts:1; use a declared package import instead.",
	]);
});

test("production files cannot import dev-only workspace dependencies", () => {
	const root = workspace();
	manifest(
		root,
		"packages/core",
		"@cabane/core",
		{},
		{ "@cabane/sqlite": "workspace:*" },
	);
	write(root, "packages/core/storage/oplog.ts", 'import "@cabane/sqlite";');
	expect(checkLayers(root)).toEqual([
		"@cabane/core -> @cabane/sqlite: production workspace import @cabane/sqlite in packages/core/storage/oplog.ts:1 is only in devDependencies; declare it in dependencies under the scripts/layers.ts allowance.",
	]);
});

test("relative imports outside every package fail", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	write(
		root,
		"packages/core/storage/oplog.ts",
		'import "../../../scripts/layers";',
	);
	expect(checkLayers(root)).toEqual([
		"@cabane/core -> (outside workspace packages): relative cross-package import ../../../scripts/layers in packages/core/storage/oplog.ts:1; use a declared package import instead.",
	]);
});

test.each([
	["packages/core", "@cabane/core", "packages/core/testing.ts"],
	["packages/board", "@cabane/board", "packages/board/src/test-db.ts"],
	["packages/board", "@cabane/board", "packages/board/src/stories/fixtures.ts"],
])(
	"explicit test support in %s permits dev dependencies: %s %s",
	(directory, name, file) => {
		const root = workspace();
		manifest(root, directory, name, {}, { "@cabane/sqlite": "workspace:*" });
		write(root, file, 'import "@cabane/sqlite/testing";');
		expect(checkLayers(root)).toEqual([]);
		write(root, file.replace(".ts", "-other.ts"), 'import "@cabane/sqlite";');
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
	manifest(root, "packages/board", "@cabane/board");
	write(root, "packages/board/src/test-db.ts", "export {};");
	write(root, "packages/board/src/stories/fixtures.ts", 'import "../test-db";');
	write(root, "packages/board/src/index.test.ts", 'import "./test-db";');
	write(root, "packages/board/src/index.ts", 'import "./test-db-other";');
	expect(checkLayers(root)).toEqual([]);
	write(root, "packages/board/src/index.ts", 'import "./test-db";');
	expect(checkLayers(root)).toEqual([
		"@cabane/board -> @cabane/board: production import ./test-db in packages/board/src/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
	write(root, "packages/board/src/stories/index.tsx", "export {};");
	write(root, "packages/board/src/index.ts", 'import "./stories";');
	expect(checkLayers(root)).toEqual([
		"@cabane/board -> @cabane/board: production import ./stories in packages/board/src/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("production imports permit declared runtime dependency subpaths", () => {
	const root = workspace();
	manifest(root, "packages/sqlite", "@cabane/sqlite", {
		"@cabane/core": "workspace:*",
	});
	write(root, "packages/sqlite/index.ts", 'import "@cabane/core/db";');
	expect(checkLayers(root)).toEqual([]);
});

for (const specifier of [
	"@cabane/core/testing",
	"@cabane/core/testing/issue-corpus",
	"@cabane/core/testing/fixtures/issue-corpus/issues.json",
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
		manifest(root, "packages/sqlite", "@cabane/sqlite", {
			"@cabane/core": "workspace:*",
		});
		write(root, "packages/sqlite/index.ts", `\n${source}`);
		expect(checkLayers(root)).toEqual([
			`@cabane/sqlite -> @cabane/core: production import ${specifier} in packages/sqlite/index.ts:2 uses test support; move it to a test or listed test-support file.`,
		]);
	});
}

test.each([
	"../testing",
	"../testing.ts",
	"../testing.js",
	"../testing/issue-corpus-harness",
	"../storage/../testing/issue-corpus-seed.ts",
	"@cabane/core/testing",
])("core production files reject their own test support: %s", (specifier) => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	write(root, "packages/core/storage/read.ts", `import "${specifier}";`);
	expect(checkLayers(root)).toEqual([
		`@cabane/core -> @cabane/core: production import ${specifier} in packages/core/storage/read.ts:1 uses test support; move it to a test or listed test-support file.`,
	]);
});

test("tests and listed support permit core test support; similar names are production", () => {
	const root = workspace();
	manifest(root, "packages/core", "@cabane/core");
	for (const file of [
		"testing.ts",
		"storage/read.test.ts",
		"storage/read.test.tsx",
	]) {
		write(
			root,
			`packages/core/${file}`,
			'import "@cabane/core/testing";\nimport "./testing/issue-corpus-harness";',
		);
	}
	write(
		root,
		"packages/core/index.ts",
		'import "./testing-other";\nimport "@cabane/core/testing-other";',
	);
	expect(checkLayers(root)).toEqual([]);
	write(
		root,
		"packages/core/testing-other.ts",
		'import "@cabane/core/testing";',
	);
	expect(checkLayers(root)).toEqual([
		"@cabane/core -> @cabane/core: production import @cabane/core/testing in packages/core/testing-other.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("extension packages enforce the rule and listed support can import subpaths", () => {
	const root = workspace();
	const policy = {
		...rules,
		"@cabane/sample": {
			layer: "extension",
			dependencies: ["@cabane/core"],
			devDependencies: [],
			testSupport: ["extensions/sample/support.ts"],
		},
	};
	manifest(root, "extensions/sample", "@cabane/sample", {
		"@cabane/core": "workspace:*",
	});
	for (const file of ["support.ts", "index.test.ts", "index.ts"]) {
		write(
			root,
			`extensions/sample/${file}`,
			'import "@cabane/core/testing/issue-corpus";',
		);
	}
	expect(checkWorkspaceLayers(root, policy)).toEqual([
		"@cabane/sample -> @cabane/core: production import @cabane/core/testing/issue-corpus in extensions/sample/index.ts:1 uses test support; move it to a test or listed test-support file.",
	]);
});

test("extension production type imports may use declared development dependencies", () => {
	const root = workspace();
	manifest(
		root,
		"extensions/loop",
		"@cabane/loop",
		{},
		{ "@cabane/core": "workspace:*" },
	);
	write(
		root,
		"extensions/loop/index.ts",
		[
			'import type { Task } from "@cabane/core";',
			'export type { Result } from "@cabane/core";',
			'import { type Task as T, type Result as R } from "@cabane/core";',
			'export { type Task as Other } from "@cabane/core";',
		].join("\n"),
	);
	expect(
		checkWorkspaceLayers(root, {
			"@cabane/loop": {
				layer: "extension",
				dependencies: [],
				devDependencies: ["@cabane/core"],
			},
		}),
	).toEqual([]);
});

for (const source of [
	'import { Planner } from "@cabane/core";',
	'import { type Task, Planner } from "@cabane/core";',
	'import Planner, { type Task } from "@cabane/core";',
	'import {} from "@cabane/core";',
	'import "@cabane/core";',
	'export { Planner } from "@cabane/core";',
	'export * from "@cabane/core";',
	'const core = import("@cabane/core");',
]) {
	test(`extension production value import is refused: ${source}`, () => {
		const root = workspace();
		manifest(
			root,
			"extensions/loop",
			"@cabane/loop",
			{},
			{ "@cabane/core": "workspace:*" },
		);
		write(root, "extensions/loop/index.ts", source);
		expect(
			checkWorkspaceLayers(root, {
				"@cabane/loop": {
					layer: "extension",
					dependencies: [],
					devDependencies: ["@cabane/core"],
				},
			}),
		).toEqual([
			"@cabane/loop -> @cabane/core: production workspace import @cabane/core in extensions/loop/index.ts:1 is only in devDependencies; declare it in dependencies under the scripts/layers.ts allowance.",
		]);
	});
}
