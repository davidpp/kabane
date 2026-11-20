#!/usr/bin/env bun
/** Build a directory extension with its skills, copilot files and templates included. */
import {
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const DIST = join(ROOT, "dist");

export const build = async (
	into = DIST,
	root = ROOT,
): Promise<Bun.BuildOutput> => {
	rmSync(into, { recursive: true, force: true });
	const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	// A modules entry is built beside index.js, at its source path with a .js extension.
	const modules: unknown = source.kabane?.modules;
	const entry = typeof modules === "string" ? join(root, modules) : undefined;
	const result = await Bun.build({
		entrypoints: [
			join(root, "index.ts"),
			...(entry === undefined ? [] : [entry]),
		],
		root,
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
	writeFileSync(
		join(into, "package.json"),
		`${JSON.stringify(
			{
				name: source.name,
				version: source.version,
				description: source.description,
				license: source.license,
				type: "module",
				kabane: {
					extension: "./index.js",
					api: 1,
					...(entry === undefined
						? {}
						: {
								modules: `./${relative(root, entry).replace(/\.[cm]?tsx?$/, ".js")}`,
							}),
				},
			},
			null,
			"\t",
		)}\n`,
	);
	for (const directory of ["copilot", "templates"])
		cpSync(join(root, directory), join(into, directory), { recursive: true });
	// What kabane mcp serves to any session; an extension that ships none has no skills/.
	if (existsSync(join(root, "skills")))
		cpSync(join(root, "skills"), join(into, "skills"), { recursive: true });
	return result;
};

// `bun scripts/build.ts [into] [root]`: the tests build through here, in a process of their own.
if (import.meta.main) {
	const [into = DIST, root = ROOT] = process.argv
		.slice(2)
		.map((path) => resolve(path));
	const result = await build(into, root);
	for (const log of result.logs) console.error(log);
	if (!result.success) process.exit(1);
	console.error(`build: ${into}`);
}
