#!/usr/bin/env bun
/**
 * Builds the publishable `kabane` package into packages/cli/dist, the directory `npm pack` and
 * `npm publish` run in (docs/release.md):
 *
 *   bin/kabane.js         the CLI bundled for Bun, its `@cabane/*` workspace dependencies inlined
 *   bin/chunk-<hash>.js  lazy command modules and shared code
 *   types/extension.d.ts the extension contract's types, published as `kabane/extension`
 *   package.json          generated from packages/cli/package.json, no workspace dependency left
 *   README.md, LICENSE    the repository's own
 *
 * The workspace manifest stays the development one (source entry, `workspace:*` siblings), so the
 * published one is written here rather than rewritten in place: `npm cabane` and the `@cabane`
 * scope belong to other people, and a published `@cabane/*` dependency would install their code.
 */

import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateDtsBundle } from "dts-bundle-generator";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "packages/cli");
export const DIST = join(CLI, "dist");

// @opentui/core loads its native renderer, `@opentui/core-<platform>-<arch>`, at runtime from an
// optional dependency, so it must be installed on the user's machine rather than bundled.
// @opentui/react brings its own reconciler and imports react itself, so react stays external too:
// a bundled second copy would break every hook.
const EXTERNAL = ["@opentui/core", "@opentui/react", "react"] as const;

// The fields of packages/cli/package.json that describe the published package as they are.
const CARRIED = [
	"name",
	"version",
	"description",
	"keywords",
	"license",
	"repository",
	"homepage",
	"bugs",
] as const;

type Manifest = Record<string, unknown> & {
	dependencies?: Record<string, string>;
};

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const fail = (message: string): never => {
	console.error(`build: ${message}`);
	process.exit(1);
};

const readManifest = (path: string): Manifest =>
	JSON.parse(readFileSync(path, "utf8")) as Manifest;

// The board is what imports the externals, so its manifest holds the versions the tests ran on.
const externalDependencies = (): Record<string, string> => {
	const board = readManifest(join(ROOT, "packages/board/package.json"));
	return Object.fromEntries(
		EXTERNAL.map((name) => {
			const version = board.dependencies?.[name];
			if (!version || !EXACT_VERSION.test(version))
				return fail(
					`packages/board/package.json must pin ${name} to an exact version`,
				);
			return [name, version];
		}),
	);
};

const publishManifest = (): Manifest => {
	const cli = readManifest(join(CLI, "package.json"));
	const bunVersion = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
	return {
		...Object.fromEntries(CARRIED.map((field) => [field, cli[field]])),
		type: "module",
		bin: { kabane: "bin/kabane.js" },
		files: ["bin", "types"],
		exports: { "./extension": { types: "./types/extension.d.ts" } },
		engines: { bun: `>=${bunVersion}` },
		dependencies: externalDependencies(),
	};
};

const bundle = async (): Promise<void> => {
	const result = await Bun.build({
		entrypoints: [join(CLI, "index.ts")],
		outdir: join(DIST, "bin"),
		naming: { entry: "kabane.js", chunk: "chunk-[hash].js" },
		splitting: true,
		target: "bun",
		external: [...EXTERNAL],
		// Without it the JSX compiles to the development runtime.
		define: {
			"process.env.NODE_ENV": JSON.stringify("production"),
			"process.env.KABANE_BUNDLED": JSON.stringify("1"),
		},
		// Which source files went in, for build verification.
		metafile: true,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		fail("bun build failed");
	}
	writeFileSync(
		join(DIST, "metafile.json"),
		JSON.stringify(result.metafile, null, 2),
	);
	plainHashbang(join(DIST, "bin/kabane.js"));
};

// The bundle keeps the source entry's hashbang, whose define needs `env -S`, which some systems'
// env lacks. The bundle has NODE_ENV defined already, so it gets the plain one.
const plainHashbang = (file: string): void => {
	const text = readFileSync(file, "utf8");
	writeFileSync(file, text.replace(/^#!.*\n/, "#!/usr/bin/env bun\n"));
};

/** Inline workspace and zod declarations so type-only consumers need no extra package. */
const buildExtensionTypes = (into: string): void => {
	const work = mkdtempSync(join(tmpdir(), "kabane-types-"));
	const config = join(work, "tsconfig.json");
	// Workspace symlinks are source, not external declaration libraries.
	writeFileSync(
		config,
		JSON.stringify({
			extends: join(ROOT, "packages/extension/tsconfig.json"),
			compilerOptions: {
				typeRoots: [join(ROOT, "node_modules/@types")],
				paths: {
					"@cabane/core": [join(ROOT, "packages/core/index.ts")],
				},
			},
		}),
	);
	try {
		const [declaration] = generateDtsBundle(
			[
				{
					filePath: join(ROOT, "packages/extension/types.ts"),
					libraries: {
						inlinedLibraries: ["@cabane/core", "zod"],
						allowedTypesLibraries: [],
					},
					output: { exportReferencedTypes: false },
				},
			],
			{ preferredConfigPath: config },
		);
		if (!declaration)
			return fail("extension declaration generation produced no output");
		mkdirSync(join(into, "types"), { recursive: true });
		// The bundler promotes type-only namespace re-exports to value exports. Keep the
		// declarations private and re-export their names explicitly as types.
		const namespaces: string[] = [];
		const typesOnly = declaration.replace(
			/^export declare namespace (\w+)/gm,
			(_, name: string) => {
				namespaces.push(name);
				return `declare namespace ${name}`;
			},
		);
		writeFileSync(
			join(into, "types/extension.d.ts"),
			`${typesOnly}\nexport type { ${namespaces.join(", ")} };\n`,
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
};

export const build = async (): Promise<void> => {
	rmSync(DIST, { recursive: true, force: true });
	await bundle();
	buildExtensionTypes(DIST);
	cpSync(join(ROOT, "README.md"), join(DIST, "README.md"));
	cpSync(join(ROOT, "LICENSE"), join(DIST, "LICENSE"));
	writeFileSync(
		join(DIST, "package.json"),
		`${JSON.stringify(publishManifest(), null, "\t")}\n`,
	);
};

if (import.meta.main) {
	await build();
	console.error(`build: ${DIST}`);
}
