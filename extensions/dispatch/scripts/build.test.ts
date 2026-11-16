import { expect, it } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "./build";

const EXTENSION = resolve(import.meta.dir, "..");
const CLI = resolve(EXTENSION, "../../packages/cli/index.ts");

const files = (root: string): string[] =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
		.sort();

it("builds a relocatable extension that kabane loads from a home, with its templates and copilot files", async () => {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-build-")));
	try {
		const output = join(work, "output");
		const result = await build(output);
		expect(result.success).toBe(true);
		expect(result.logs).toEqual([]);
		const home = join(work, "home");
		const installed = join(home, "extensions/dispatch");
		mkdirSync(join(home, "extensions"), { recursive: true });
		cpSync(output, installed, { recursive: true });
		rmSync(output, { recursive: true });
		const manifest = JSON.parse(
			readFileSync(join(installed, "package.json"), "utf8"),
		);
		expect(manifest.kabane).toEqual({ extension: "./index.js", api: 1 });
		expect(manifest.dependencies).toBeUndefined();
		for (const directory of ["copilot", "templates"]) {
			const shipped = files(join(EXTENSION, directory));
			expect(files(join(installed, directory))).toEqual(shipped);
			for (const file of shipped)
				expect(readFileSync(join(installed, directory, file))).toEqual(
					readFileSync(join(EXTENSION, directory, file)),
				);
		}
		expect(readFileSync(join(installed, "index.js"), "utf8")).not.toContain(
			"@cabane/",
		);
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				actor: "test",
				deviceId: "test",
				extensions: ["dispatch"],
			}),
		);
		const kabane = (...args: string[]) => {
			const run = Bun.spawnSync([process.execPath, CLI, ...args], {
				cwd: work,
				env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
			});
			return {
				code: run.exitCode,
				stdout: run.stdout.toString().trim(),
				stderr: run.stderr.toString(),
			};
		};
		// The stamp main computed for these bytes, from the built copy's own templates/.
		expect(kabane("dispatch", "stamp")).toEqual({
			code: 0,
			stdout: "dispatch@70afac8b9cd2",
			stderr: "",
		});
		rmSync(join(installed, "templates/dispatch"), { recursive: true });
		const missing = kabane("dispatch", "stamp");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain(join(installed, "templates/dispatch"));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60_000);

// No extension here names a modules entry yet; a source manifest that does keeps it in the build.
it("carries a modules entry into the built manifest, at the built path kabane imports", async () => {
	const work = realpathSync(
		mkdtempSync(join(tmpdir(), "dispatch-build-modules-")),
	);
	try {
		const source = join(work, "source");
		const files: Record<string, string> = {
			"package.json": JSON.stringify({
				name: "sample",
				version: "0.0.0",
				kabane: {
					extension: "./index.ts",
					api: 1,
					modules: "./src/modules.ts",
				},
			}),
			"index.ts": 'export default () => ({ name: "sample" });\n',
			"src/modules.ts": "export default () => [];\n",
		};
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(source, file)), { recursive: true });
			writeFileSync(join(source, file), text);
		}
		for (const directory of ["copilot", "templates"])
			mkdirSync(join(source, directory));
		const home = join(work, "home");
		const installed = join(home, "extensions/sample");
		const result = await build(installed, source);
		expect(result.logs).toEqual([]);
		expect(result.success).toBe(true);
		expect(
			JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).kabane,
		).toEqual({ extension: "./index.js", api: 1, modules: "./src/modules.js" });
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				actor: "test",
				deviceId: "test",
				extensions: ["sample"],
			}),
		);
		const list = () =>
			Bun.spawnSync([process.execPath, CLI, "list"], {
				cwd: work,
				env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
			});
		expect(list().exitCode).toBe(0);
		// The built manifest is what kabane follows: without the file it names, the database stays shut.
		rmSync(join(installed, "src/modules.js"));
		const stopped = list();
		expect(stopped.exitCode).toBe(1);
		expect(stopped.stderr.toString()).toContain("Extension sample:");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60_000);
