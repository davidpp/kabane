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
import { join, resolve } from "node:path";
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
			stdout: "dispatch@dacd7416f173",
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
