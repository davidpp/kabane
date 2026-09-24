#!/usr/bin/env bun
/**
 * Builds the publishable `kabane` package into packages/cli/dist, the directory `npm pack` and
 * `npm publish` run in (docs/release.md):
 *
 *   bin/kabane.js         the CLI bundled for Bun, every `@cabane/*` workspace package inlined
 *   templates/dispatch/   the copilot's dispatch skill template, read from disk at runtime
 *   package.json          generated from packages/cli/package.json, no workspace dependency left
 *   README.md, LICENSE    the repository's own
 *
 * The workspace manifest stays the development one (source entry, `workspace:*` siblings), so the
 * published one is written here rather than rewritten in place: `npm cabane` and the `@cabane`
 * scope belong to other people, and a published `@cabane/*` dependency would install their code.
 */

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

const bundle = async (): Promise<void> => {
	const result = await Bun.build({
		entrypoints: [join(CLI, "index.ts")],
		outdir: join(DIST, "bin"),
		naming: "kabane.js",
		target: "bun",
		external: [...EXTERNAL],
		// Without it the JSX compiles to the development runtime.
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		fail("bun build failed");
	}
};

export const build = async (): Promise<void> => {
	rmSync(DIST, { recursive: true, force: true });
	await bundle();
	// CopilotInstructions resolves the template as ../templates/dispatch from its own module, which
	// in the bundle is bin/kabane.js.
	cpSync(
		join(ROOT, "packages/acp/templates/dispatch"),
		join(DIST, "templates/dispatch"),
		{ recursive: true },
	);
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
