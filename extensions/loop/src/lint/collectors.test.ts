import { afterEach, expect, it } from "bun:test";
import "@kabane/core/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result } from "@kabane/core";
import { testHost } from "../test-host";
import { LintCollectors } from "./collectors";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

it("collects the parent and closed children through the real host record", async () => {
	const home = mkdtempSync(join(tmpdir(), "loop-lint-"));
	homes.push(home);
	value(await Planner.init(home));
	const parent = value(
		await Planner.addTask(home, { title: "parent", kind: "issue" }),
	);
	const child = value(
		await Planner.addTask(home, {
			title: "child",
			kind: "issue",
			parentTaskId: parent.id,
			state: "done",
			description: "Change packages/core/index.ts",
		}),
	);
	const result = value(
		await LintCollectors.collect({
			record: testHost(home).record,
			parentTaskId: parent.id,
		}),
	);
	expect(result.subtasks.map((task) => task.id)).toEqual([parent.id, child.id]);
	expect(result.packagePaths).toEqual(["packages/core"]);
	expect(result.subtaskCount).toBe(1);
});
