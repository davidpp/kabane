#!/usr/bin/env bun
/**
 * Builds the publishable `kabane` package into packages/cli/dist, the directory `npm pack` and
 * `npm publish` run in (docs/release.md):
 *
 *   bin/kabane.js         the CLI bundled for Bun, every `@cabane/*` workspace package inlined,
 *                         each official extension under extensions/ among them
 *   templates/<name>/     each packages/acp/templates/<name> (the copilot's dispatch skill) and
 *                         extensions/<ext>/templates/<name> (the loop's lenses), read from disk
 *                         at runtime as ../templates/<name> from bin/kabane.js; one namespace, so
 *                         two sources of one name fail the build
 *   package.json          generated from packages/cli/package.json, no workspace dependency left
 *   README.md, LICENSE    the repository's own
 *
 * The workspace manifest stays the development one (source entry, `workspace:*` siblings), so the
 * published one is written here rather than rewritten in place: `npm cabane` and the `@cabane`
 * scope belong to other people, and a published `@cabane/*` dependency would install their code.
 */

import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../packages/core/result";

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
		files: ["bin", "templates"],
		engines: { bun: `>=${bunVersion}` },
		dependencies: externalDependencies(),
	};
};

const EXTENSIONS = join(ROOT, "extensions");

// Every workspace member under extensions/ is an official extension.
const extensionNames = (): string[] =>
	existsSync(EXTENSIONS)
		? readdirSync(EXTENSIONS, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
		: [];

// The CLI's list has to import every extension: one the bundle leaves out would be a directory
// nobody can enable.
const checkExtensionsCarried = (bundled: readonly string[]): void => {
	const files = bundled.map((input) => relative(ROOT, resolve(input)));
	for (const name of extensionNames()) {
		const prefix = `extensions/${name}/`;
		if (!files.some((file) => file.startsWith(prefix)))
			fail(
				`${prefix} is not in the bundle; add it to the official list in packages/cli/src/extensions.ts`,
			);
	}
};

const bundle = async (): Promise<void> => {
	const result = await Bun.build({
		entrypoints: [join(CLI, "index.ts")],
		outdir: join(DIST, "bin"),
		naming: "kabane.js",
		target: "bun",
		external: [...EXTERNAL],
		// Without it the JSX compiles to the development runtime.
		define: {
			"process.env.NODE_ENV": JSON.stringify("production"),
			"process.env.KABANE_BUNDLED": JSON.stringify("1"),
		},
		// Which source files went in, for the extension check below.
		metafile: true,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		fail("bun build failed");
	}
	checkExtensionsCarried(Object.keys(result.metafile?.inputs ?? {}));
};

/**
 * Copies each `<root>/<name>` to `<into>/<name>`. Every bundled module resolves its templates as
 * ../templates/<name> from bin/kabane.js (CopilotInstructions, the loop's Lenses), so the names
 * share one directory: a name two roots both hold is an error, raised before anything is copied.
 */
export const copyTemplates = (
	roots: readonly string[],
	into: string,
): Result<string[]> => {
	const sources = new Map<string, string>();
	for (const root of roots)
		for (const name of readdirSync(root)) {
			const taken = sources.get(name);
			if (taken !== undefined)
				return err(
					new Error(
						`templates/${name} comes from both ${taken} and ${root}; rename one of them`,
					),
				);
			sources.set(name, root);
		}
	for (const [name, root] of sources)
		cpSync(join(root, name), join(into, name), { recursive: true });
	return ok([...sources.keys()]);
};

// The copilot's templates, then each extension's.
const templateRoots = (): string[] =>
	[
		join(ROOT, "packages/acp/templates"),
		...extensionNames().map((name) => join(EXTENSIONS, name, "templates")),
	].filter((root) => existsSync(root));

export const build = async (): Promise<void> => {
	rmSync(DIST, { recursive: true, force: true });
	await bundle();
	const templates = copyTemplates(templateRoots(), join(DIST, "templates"));
	if (!templates.ok) fail(templates.error.message);
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
