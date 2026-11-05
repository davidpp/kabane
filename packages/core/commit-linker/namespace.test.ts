import "../testing";
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture } from "../scope/git-fixture";
import { Planner } from "../storage";
import { CommitLinker } from "./namespace";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories)
		rmSync(directory, { recursive: true, force: true });
	directories.length = 0;
});

it("scans real commit bodies, skips unknown tasks, and never closes an already-linked commit twice", async () => {
	const directory = mkdtempSync(join(tmpdir(), "kabane-commit-linker-"));
	directories.push(directory);
	GitFixture.run(directory, ["init", "-q"]);
	const home = join(directory, "device");
	const initialized = await Planner.init(home);
	if (!initialized.ok) throw initialized.error;
	const added = await Planner.addTask(home, {
		title: "Link this",
		scopeUri: "jcab94",
	});
	if (!added.ok) throw added.error;
	const task = added.value;
	GitFixture.run(directory, [
		"commit",
		"--allow-empty",
		"-m",
		"Ship a change",
		"-m",
		`Closes ${task.shortId}; refs JZZZ-99999`,
	]);
	const first = await CommitLinker.scanAndLink(home, directory);
	if (!first.ok) throw first.error;
	expect(first.value).toEqual({ scanned: 1, linked: 1, closed: 1, errors: [] });
	const logs = await Planner.getWorkLogs(home, task.id);
	if (!logs.ok) throw logs.error;
	expect(logs.value).toHaveLength(1);
	expect(logs.value[0]?.refs[0]?.uri).toBe(
		`commit:${GitFixture.run(directory, ["rev-parse", "HEAD"]).trim()}`,
	);
	const closed = await Planner.getTask(home, task.id);
	if (!closed.ok) throw closed.error;
	expect(closed.value?.state).toBe("done");
	const reopened = await Planner.updateTask(home, task.id, { state: "next" });
	if (!reopened.ok) throw reopened.error;
	const second = await CommitLinker.scanAndLink(home, directory);
	if (!second.ok) throw second.error;
	expect(second.value).toEqual({
		scanned: 1,
		linked: 0,
		closed: 0,
		errors: [],
	});
	const unchanged = await Planner.getTask(home, task.id);
	if (!unchanged.ok) throw unchanged.error;
	expect(unchanged.value?.state).toBe("next");
});
