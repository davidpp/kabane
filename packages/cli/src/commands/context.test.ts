import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result } from "@cabane/core";
import { run } from "../main";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

it("lists in its usage the sections the invalid-section error lists, the registered ones included", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-context-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const kabane = (argv: string[]) => run(argv, env, home);
	const init = await kabane([
		"init",
		"--actor",
		"cabane://actor/human/test",
		"--device",
		"test",
	]);
	expect(init.exitCode).toBe(0);
	const task = unwrap(
		await Planner.addTask(home, { title: "Sections", kind: "issue" }),
	);

	const help = (await kabane(["context", "--help"])).text;
	const usage = /--sections ([^\] ]+)\]/.exec(help)?.[1]?.split(",");
	const refused = await kabane([
		"context",
		task.id,
		"--format",
		"concise",
		"--sections",
		"bogus",
	]);
	expect(refused.exitCode).toBe(2);
	const valid = /Valid sections: (.+?)\. Unknown/
		.exec(refused.text)?.[1]
		?.split(", ");
	expect(usage).toContain("handoff.latest");
	expect(usage).toEqual(valid);
});
