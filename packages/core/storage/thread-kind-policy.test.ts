import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KabaneModule } from "../module";
import type { Result } from "../result";
import type { Task } from "../schemas";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";

// A module's code declaration carries what the generic paths do with its kind, read when they run.
const routines: KabaneModule = {
	name: "routines",
	threadKinds: [
		{
			name: "routine",
			label: "Routine",
			initialState: "inbox",
			unlisted: true,
		},
	],
};

let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-kind-policy-"));
	configureTestRuntime({ modules: [routines] });
	expect((await Planner.init(base)).ok).toBe(true);
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const routine = async (): Promise<Task> =>
	value(await Planner.addTask(base, { title: "water", kind: "routine" }));
const listed = async (kind?: string): Promise<string[]> =>
	value(await Planner.queryTasks(base, kind ? { kind } : {})).map(
		(task) => task.id,
	);

it("starts a new thread of a module's kind in the state it declares", async () => {
	expect((await routine()).state).toBe("inbox");
});

it("leaves a module's unlisted kind out of a listing that names no kind", async () => {
	const kept = await routine();
	const task = value(await Planner.addTask(base, { title: "a task" }));
	expect(await listed()).toEqual([task.id]);
	expect(await listed("routine")).toEqual([kept.id]);
});

it("refuses to take the state of a module's workflow kind away", async () => {
	const kept = await routine();
	const refused = await Planner.updateTask(base, kept.id, { state: null });
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.error.message).toContain("A routine keeps");
});

it("reads the declarations at call time: without the module the kind is stateless and listed", async () => {
	const kept = await routine();
	configureTestRuntime();
	const plain = await routine();
	expect(plain.state).toBeUndefined();
	expect((await listed()).sort()).toEqual([kept.id, plain.id].sort());
	expect(value(await Planner.getTask(base, kept.id))?.state).toBe("inbox");
	expect(
		value(await Planner.updateTask(base, kept.id, { state: null }))?.state,
	).toBeUndefined();
});
