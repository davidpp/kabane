// `kabane loop` as the CLI calls it: argv parsed by the shared parser, run against a real tracker.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { parseArgs } from "@cabane/extension";
import { loop } from "./extension";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-extension-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const kabaneLoop = (...argv: string[]) => {
	const command = loop.commands?.find((c) => c.name === "loop");
	if (!command) throw new Error("no loop command");
	return command.run(parseArgs(argv), {
		home,
		store: home,
		cwd: home,
		actor: "cabane://actor/human/test",
	});
};

describe("kabane loop start", () => {
	it("refuses a flag it does not take, rather than starting without it", async () => {
		const refused = await kabaneLoop(
			"start",
			"K-1",
			"--work-tree",
			"--gates",
			"test=bun test",
		);
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			"Error: Unknown loop start flags: --work-tree, --gates\n",
		);
	});

	it("takes its own flags and the ones every command takes", async () => {
		const started = await kabaneLoop(
			"start",
			"K-404",
			"--worktree",
			"--as",
			"cabane://actor/human/test",
		);
		// Past the flags: the parent is what is missing.
		expect(started.exitCode).toBe(1);
		expect(started.text).not.toContain("Unknown loop start flag");
	});
});
