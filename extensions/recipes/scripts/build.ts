#!/usr/bin/env bun
/** Build the directory extension: its main entry and its modules entry, beside a built manifest and its templates. */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const DIST = join(ROOT, "dist");

export const build = async (into = DIST): Promise<Bun.BuildOutput> => {
	rmSync(into, { recursive: true, force: true });
	const source = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const result = await Bun.build({
		entrypoints: [join(ROOT, "index.ts"), join(ROOT, "modules.ts")],
		root: ROOT,
		outdir: into,
		target: "bun",
		plugins: [
			{
				name: "relocate-templates",
				setup(builder) {
					// Flattening src/ into index.js moves the module one directory up.
					builder.onLoad({ filter: /\/src\/job-skill\.ts$/ }, ({ path }) => ({
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
	const manifest = {
		name: source.name,
		version: source.version,
		description: source.description,
		license: source.license,
		type: "module",
		kabane: { extension: "./index.js", modules: "./modules.js", api: 1 },
	};
	writeFileSync(
		join(into, "package.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	cpSync(join(ROOT, "templates"), join(into, "templates"), { recursive: true });
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
