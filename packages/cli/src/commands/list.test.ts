import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../main";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

it("refuses a kind name add and kabane_list refuse, on one line, instead of listing nothing", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-list-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	expect(
		(
			await run(
				["init", "--actor", "kabane://actor/human/test", "--device", "test"],
				env,
				home,
			)
		).exitCode,
	).toBe(0);
	const listed = await run(["list", "--kind", "Bad Kind"], env, home);
	expect(listed.exitCode).not.toBe(0);
	expect(listed.text).toContain("--kind must be lowercase letters");
	expect(listed.text).not.toContain("No tasks found");
	const added = await run(["add", "x", "--kind", "Bad Kind"], env, home);
	expect(added.exitCode).not.toBe(0);
	expect(added.text).toContain("Invalid draft: kind: must be lowercase");
	expect(added.text).not.toContain('"code"');
	expect((await run(["list", "--kind", "signal"], env, home)).exitCode).toBe(0);
});
