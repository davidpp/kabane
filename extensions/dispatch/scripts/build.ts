#!/usr/bin/env bun
/** Build a directory extension with its copilot files and templates included. */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const DIST = join(ROOT, "dist");

export const build = async (into = DIST): Promise<Bun.BuildOutput> => {
	rmSync(into, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: [join(ROOT, "index.ts")],
		outdir: into,
		target: "bun",
		plugins: [
			{
				name: "relocate-templates",
				setup(builder) {
					// Flattening src/ into index.js moves the module one directory up.
					builder.onLoad({ filter: /\/src\/templates\.ts$/ }, ({ path }) => ({
						contents: readFileSync(path, "utf8").replace(
							'new URL("../templates/", import.meta.url)',
							'new URL("./templates/", import.meta.url)',
						),
						loader: "ts",
					}));
				},
			},
		],
	});
	if (!result.success) return result;
	const source = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	writeFileSync(
		join(into, "package.json"),
		`${JSON.stringify(
			{
				name: source.name,
				version: source.version,
				description: source.description,
				license: source.license,
				type: "module",
				kabane: { extension: "./index.js", api: 1 },
			},
			null,
			"\t",
		)}\n`,
	);
	for (const directory of ["copilot", "templates"])
		cpSync(join(ROOT, directory), join(into, directory), { recursive: true });
	return result;
};

if (import.meta.main) {
	const result = await build();
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	console.error(`build: ${DIST}`);
}
