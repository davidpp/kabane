import { expect, it } from "bun:test";
import "@cabane/core/testing";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ok, Planner } from "@cabane/core";
import { Settings } from "@cabane/extension";
import type * as LoopPackage from "../index";
import { TestHarnesses } from "../src/test-harnesses";
import { testHost } from "../src/test-host";
import { build } from "./build";

it("builds a relocatable loop with its client, procedures and working shipped lenses", async () => {
	const work = mkdtempSync(join(tmpdir(), "loop-build-"));
	try {
		const output = join(work, "output");
		const result = await build(output);
		expect(result.success).toBe(true);
		expect(result.logs).toEqual([]);
		expect(JSON.parse(readFileSync(`${output}.metafile.json`, "utf8"))).toEqual(
			result.metafile,
		);
		expect(existsSync(join(output, "metafile.json"))).toBe(false);
		expect(
			Object.keys(result.metafile?.inputs ?? {}).some((file) =>
				file.includes("packages/acp/src/client.ts"),
			),
		).toBe(true);
		const installed = join(work, "home/extensions/loop");
		cpSync(output, installed, { recursive: true });
		rmSync(output, { recursive: true });
		const manifest = JSON.parse(
			readFileSync(join(installed, "package.json"), "utf8"),
		);
		expect(manifest.kabane).toEqual({ extension: "./index.js", api: 1 });
		expect(manifest.dependencies).toBeUndefined();
		for (const file of [
			"copilot/procedures/setup-run.md",
			"copilot/procedures/start-run.md",
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

it("ships byte-identical copies of ACP's verifier lenses", () => {
	for (const name of ["functional", "quality"])
		expect(readFileSync(join(import.meta.dir, `../lenses/${name}.md`))).toEqual(
			readFileSync(
				join(
					import.meta.dir,
					`../../../packages/acp/templates/dispatch/references/lenses/${name}.md`,
				),
			),
		);
});
