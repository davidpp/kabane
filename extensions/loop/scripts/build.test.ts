import { expect, it } from "bun:test";
import "@cabane/core/testing";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ok, Planner } from "@cabane/core";
import { Settings } from "@cabane/extension";
import type * as LoopPackage from "../index";
import { TestHarnesses } from "../src/test-harnesses";
import { testHost } from "../src/test-host";

const CLI = resolve(import.meta.dir, "../../../packages/cli/index.ts");

/** Runs the build in its own process, so a bundler failure fails only these tests. */
const build = (into: string, root?: string) => {
	const run = Bun.spawnSync([
		process.execPath,
		join(import.meta.dir, "build.ts"),
		into,
		...(root === undefined ? [] : [root]),
	]);
	return { code: run.exitCode, stderr: run.stderr.toString() };
};

it("builds a relocatable loop with its client, skills and working shipped lenses", async () => {
	const work = mkdtempSync(join(tmpdir(), "loop-build-"));
	try {
		const output = join(work, "output");
		expect(build(output)).toEqual({ code: 0, stderr: `build: ${output}\n` });
		const metafile: Bun.BuildMetafile = JSON.parse(
			readFileSync(`${output}.metafile.json`, "utf8"),
		);
		expect(existsSync(join(output, "metafile.json"))).toBe(false);
		expect(
			Object.keys(metafile.inputs).some((file) =>
				file.includes("packages/acp/src/client.ts"),
			),
		).toBe(true);
		const emitted = Object.values(metafile.outputs)
			.flatMap((output) => Object.entries(output.inputs))
			.filter(([, input]) => input.bytesInOutput > 0)
			.map(([file]) => file);
		expect(emitted.filter((file) => file.startsWith("packages/core/"))).toEqual(
			["packages/core/result.ts"],
		);
		for (const file of ["instructions.ts", "templates.ts"])
			expect(emitted).not.toContain(`packages/acp/src/${file}`);
		const installed = join(work, "home/extensions/loop");
		cpSync(output, installed, { recursive: true });
		rmSync(output, { recursive: true });
		const manifest = JSON.parse(
			readFileSync(join(installed, "package.json"), "utf8"),
		);
		expect(manifest.kabane).toEqual({ extension: "./index.js", api: 1 });
		expect(manifest.dependencies).toBeUndefined();
		for (const file of [
			"skills/loop-run/SKILL.md",
			"lenses/functional.md",
			"lenses/quality.md",
		])
			expect(readFileSync(join(installed, file), "utf8")).toBe(
				readFileSync(join(import.meta.dir, "..", file), "utf8"),
			);
		const extension: typeof LoopPackage = await import(
			pathToFileURL(join(installed, "index.js")).href
		);
		const home = join(work, "home");
		const host = testHost(home);
		expect(extension.default(host).name).toBe("loop");
		const initialized = await Planner.init(home);
		if (!initialized.ok) throw initialized.error;
		const added = await Planner.addTask(home, {
			title: "Check the installed lenses",
			kind: "issue",
			state: "next",
		});
		if (!added.ok) throw added.error;
		const deps = {
			home,
			basePath: home,
			cwd: work,
			host,
			settings: Settings.port(async () => ok([])),
		};
		const input = {
			parent: added.value.id,
			dir: work,
			config: {
				worktree: false,
				lenses: ["functional", "quality"],
				harnesses: TestHarnesses.overrides({
					claude: { command: process.execPath },
				}),
			},
		};
		const prepared = await extension.Loop.prepare(deps, input);
		if (!prepared.ok) throw prepared.error;
		expect(prepared.value.config.lenses).toEqual(["functional", "quality"]);
		unlinkSync(join(installed, "lenses/quality.md"));
		const missing = await extension.Loop.prepare(deps, input);
		expect(missing.ok).toBe(false);
		if (!missing.ok)
			expect(missing.error.message).toContain(
				join(installed, "lenses/quality.md"),
			);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60_000);

// No extension here names a modules entry yet; a source manifest that does keeps it in the build.
it("carries a modules entry into the built manifest, at the built path kabane imports", async () => {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "loop-build-modules-")));
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
		mkdirSync(join(source, "lenses"));
		const home = join(work, "home");
		const installed = join(home, "extensions/sample");
		expect(build(installed, source)).toEqual({
			code: 0,
			stderr: `build: ${installed}\n`,
		});
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
