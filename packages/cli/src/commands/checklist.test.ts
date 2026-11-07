import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecklistItemView } from "@cabane/checklist";
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

const device = async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-checklist-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const init = await run(
		["init", "--actor", "cabane://actor/human/test", "--device", "test"],
		env,
		home,
	);
	expect(init.exitCode).toBe(0);
	return { home, kabane: (argv: string[]) => run(argv, env, home) };
};

it("adds, ticks, edits and lists an issue's checklist, with the receipts the MCP tools print", async () => {
	const { home, kabane } = await device();
	const task = unwrap(
		await Planner.addTask(home, { title: "Steps", kind: "issue" }),
	);
	const label = task.shortId ?? task.id;

	expect((await kabane(["checklist", label])).text).toBe(
		`No checklist items on ${label}.`,
	);
	expect((await kabane(["checklist", "add", label, "Write", "it"])).text).toBe(
		`${label} 0/1 · added ${label}.1`,
	);
	expect(
		(await kabane(["checklist", "add", label, "Ship", "--at", "1"])).text,
	).toBe(`${label} 0/2 · added ${label}.2`);
	expect((await kabane(["checklist", "tick", `${label}.1`])).text).toBe(
		`${label} 1/2 · ticked ${label}.1`,
	);
	expect(
		(await kabane(["checklist", "edit", `${label}.2`, "--at", "2"])).text,
	).toBe(`${label} 1/2 · moved ${label}.2 to 2`);

	const listed = await kabane(["checklist", label, "--json"]);
	expect(listed.exitCode).toBe(0);
	const { items } = listed.json as { items: ChecklistItemView[] };
	expect(items.map((item) => [item.handle, item.done, item.doneBy])).toEqual([
		[`${label}.1`, true, "cabane://actor/human/test"],
		[`${label}.2`, false, undefined],
	]);
	expect((await kabane(["checklist", label])).text).toBe(
		`## Checklist 1/2\n\n- [x] ${label}.1 Write it id:${items[0]?.id}\n- [ ] ${label}.2 Ship id:${items[1]?.id}`,
	);

	expect(
		(await kabane(["checklist", "tick", "--undo", `${label}.1`])).exitCode,
	).toBe(2);
	expect(
		(await kabane(["checklist", "tick", `${label}.1`, "--undo"])).text,
	).toBe(`${label} 0/2 · unticked ${label}.1`);
	expect(
		(await kabane(["checklist", "edit", `${label}.1`, "--at", "first"]))
			.exitCode,
	).toBe(2);
	const removed = await kabane(["checklist", "edit", `${label}.1`, "--remove"]);
	expect(removed.text).toBe(`${label} 0/1 · removed ${label}.1`);
	const question = await kabane(["checklist", "tick", `${label}:2`]);
	expect(question.exitCode).toBe(1);
	expect(question.text).toContain(`reads ${label}.2`);
});
