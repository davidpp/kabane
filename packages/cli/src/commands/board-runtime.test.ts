import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@cabane/extension";
import { configPath } from "../config";
import { openContext } from "../context";
import { boardDeps } from "./board-runtime";

const HOME = join(tmpdir(), `kabane-board-runtime-${crypto.randomUUID()}`);
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("the board gets the release notice unless updates.check is false", async () => {
	mkdirSync(HOME, { recursive: true });
	writeFileSync(
		configPath(HOME),
		JSON.stringify({ actor: "cabane://actor/human/ada", deviceId: "mbp" }),
	);
	const args = parseArgs([]);
	const ctx = await openContext(HOME, HOME, args);
	if (!ctx.ok) throw ctx.error;
	const wired = await boardDeps(args, ctx.value, "claude");
	wired.copilot.close();
	expect(wired.announcer).toBeDefined();
	const quiet = await boardDeps(
		args,
		{
			...ctx.value,
			config: { ...ctx.value.config, updates: { check: false } },
		},
		"claude",
	);
	quiet.copilot.close();
	expect(quiet.announcer).toBeUndefined();
});
