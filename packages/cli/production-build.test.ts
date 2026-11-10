/**
 * A source run, as a linked checkout starts it (the entry by path, through its hashbang), renders
 * with React's production build. The development build keeps native memory for every element
 * rendered, and a board on a run's tab grew by gigabytes an hour with it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ENTRY = join(import.meta.dir, "index.ts");
// The board's own React, the one its renderer loads.
const BOARD = join(import.meta.dir, "../board");

const Probed = z.object({
	nodeEnv: z.string().optional(),
	react: z.array(z.string()),
});

describe("a source run", () => {
	const work = mkdtempSync(join(tmpdir(), "kabane-production-build-"));
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it("loads React's production build through the entry's hashbang", async () => {
		const probe = join(work, "probe.cjs");
		const report = join(work, "probe.json");
		// Preloaded into the entry's process, so it is transpiled with the hashbang's defines.
		writeFileSync(
			probe,
			`require(require.resolve("react", { paths: [${JSON.stringify(BOARD)}] }));
process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({
	nodeEnv: process.env.NODE_ENV,
	react: Object.keys(require.cache).filter((path) => /\\/react\\/cjs\\//.test(path)),
})));`,
		);
		const proc = Bun.spawn([ENTRY, "--version"], {
			env: {
				...process.env,
				NODE_ENV: undefined,
				BUN_OPTIONS: `--preload ${probe}`,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);

		const probed = Probed.parse(JSON.parse(readFileSync(report, "utf8")));
		expect(probed.nodeEnv).toBe("production");
		expect(probed.react.length).toBeGreaterThan(0);
		for (const path of probed.react) expect(path).toContain(".production.");
	});
});
