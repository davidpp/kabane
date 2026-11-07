import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Oplog, Planner, type Result, withDb } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { checklistModule } from "./module";
import { Checklist } from "./storage";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const failure = <T>(result: Result<T>): string => {
	if (result.ok) throw new Error("Expected a refusal");
	return result.error.message;
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-checklist-"));
	configureTestRuntime("planner_", {
		modules: [checklistModule],
		actor: () => "cabane://actor/human/test",
	});
	unwrap(await Planner.init(base));
	unwrap(await withDb(base, (db) => Oplog.initDevice(db, "checklist-test")));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const issue = async (title = "Steps") =>
	unwrap(await Planner.addTask(base, { title, kind: "issue", scopeUri: "s" }));
const texts = async (id: string) =>
	unwrap(await Checklist.list(base, id)).map(
		(item) => `${item.handle} ${item.text}`,
	);
const ops = async () =>
	unwrap(
		await withDb(base, (db) =>
			db
				.query<{ op: string; module: string; module_schema: number }>(
					"SELECT op, module, module_schema FROM planner_sync_oplog WHERE tbl = 'task_checklist_items' ORDER BY seq",
				)
				.all(),
		),
	);

it("adds at the end or a position, hands out creation-order handles and captures every write", async () => {
	const task = await issue();
	const label = task.shortId ?? task.id;
	const first = unwrap(
		await Checklist.add(base, { id: label, items: ["Migrate", "Tools"] }),
	);
	expect(first).toMatchObject({
		issue: label,
		progress: { done: 0, total: 2 },
	});
	expect(first.items.map((item) => item.handle)).toEqual([
		`${label}.1`,
		`${label}.2`,
	]);
	unwrap(
		await Checklist.add(base, {
			id: task.id,
			items: ["Schema", "Section"],
			position: 2,
		}),
	);
	expect(await texts(task.id)).toEqual([
		`${label}.1 Migrate`,
		`${label}.3 Schema`,
		`${label}.4 Section`,
		`${label}.2 Tools`,
	]);
	expect(
		failure(
			await Checklist.add(base, { id: task.id, items: ["X"], position: 6 }),
		),
	).toBe("position 6 is outside the checklist: use 1 to 5.");
	expect((await Checklist.add(base, { id: task.id, items: [" "] })).ok).toBe(
		false,
	);
	expect(await texts(task.id)).toHaveLength(4);
	const captured = await ops();
	expect(captured).toHaveLength(4);
	expect(
		captured.every(
			(op) =>
				op.op === "insert" &&
				op.module === "checklist" &&
				op.module_schema === 1,
		),
	).toBe(true);
});

it("ticks and unticks by handle, ULID or id:, as the actor given, and leaves a ticked item alone", async () => {
	const task = await issue();
	const label = task.shortId ?? task.id;
	const [one, two] = unwrap(
		await Checklist.add(base, { id: task.id, items: ["One", "Two", "Three"] }),
	).items;
	if (!one || !two) throw new Error("Missing items");
	const ticked = unwrap(
		await Checklist.tick(
			base,
			{ items: [`${label}.1`, `id:${two.id}`, `${label}.1`] },
			"cabane://actor/agent/claude",
		),
	);
	expect(ticked.progress).toEqual({ done: 2, total: 3 });
	expect(ticked.items.map((item) => item.handle)).toEqual([
		`${label}.1`,
		`${label}.2`,
	]);
	expect(ticked.items[0]).toMatchObject({
		done: true,
		doneBy: "cabane://actor/agent/claude",
		version: 2,
	});
	const again = unwrap(await Checklist.tick(base, { items: [one.id] }));
	expect(again.items[0]).toMatchObject({
		version: 2,
		doneBy: "cabane://actor/agent/claude",
	});
	const unticked = unwrap(
		await Checklist.tick(base, { items: [one.id], done: false }),
	);
	expect(unticked.items[0]).toMatchObject({ done: false, version: 3 });
	expect(unticked.items[0]?.doneBy).toBeUndefined();
	expect(unticked.progress).toEqual({ done: 1, total: 3 });

	expect(failure(await Checklist.tick(base, { items: [`${label}:1`] }))).toBe(
		`${label}:1 is a question's handle; a checklist item's reads ${label}.1.`,
	);
	expect(
		failure(await Checklist.tick(base, { items: [`${label}.9`] })),
	).toStartWith(`No checklist item ${label}.9: ${label} has 3.`);
	const other = await issue("Other");
	const [elsewhere] = unwrap(
		await Checklist.add(base, { id: other.id, items: ["Elsewhere"] }),
	).items;
	expect(
		failure(
			await Checklist.tick(base, {
				items: [`${label}.3`, elsewhere?.id ?? ""],
			}),
		),
	).toStartWith("Tick the items of one issue per call");
	expect(unwrap(await Checklist.list(base, task.id))[2]?.done).toBe(false);
});

it("edits text, moves and removes without renumbering any handle", async () => {
	const task = await issue();
	const label = task.shortId ?? task.id;
	unwrap(await Checklist.add(base, { id: task.id, items: ["A", "B", "C"] }));
	unwrap(await Checklist.edit(base, { item: `${label}.3`, position: 1 }));
	unwrap(
		await Checklist.edit(base, { item: `${label}.1`, text: "A2", position: 3 }),
	);
	expect(await texts(task.id)).toEqual([
		`${label}.3 C`,
		`${label}.2 B`,
		`${label}.1 A2`,
	]);
	const removed = unwrap(
		await Checklist.edit(base, { item: `${label}.2`, remove: true }),
	);
	expect(removed.progress).toEqual({ done: 0, total: 2 });
	expect(removed.items[0]?.removedAt).toBeDefined();
	expect(await texts(task.id)).toEqual([`${label}.3 C`, `${label}.1 A2`]);
	unwrap(await Checklist.add(base, { id: task.id, items: ["D"] }));
	expect(await texts(task.id)).toContain(`${label}.4 D`);

	expect(failure(await Checklist.tick(base, { items: [`${label}.2`] }))).toBe(
		`Checklist item ${label}.2 was removed.`,
	);
	expect(
		failure(await Checklist.edit(base, { item: `${label}.1`, position: 4 })),
	).toBe("position 4 is outside the checklist: use 1 to 3.");
	for (const bad of [
		{ item: `${label}.1` },
		{ item: `${label}.1`, text: "X", remove: true },
	])
		expect(failure(await Checklist.edit(base, bad))).toContain(
			"Supply text, position or both; or remove: true alone.",
		);
});

it("counts progress per task, and renders the brief section only when there are items", async () => {
	const task = await issue();
	const empty = await issue("Empty");
	const label = task.shortId ?? task.id;
	const [first] = unwrap(
		await Checklist.add(base, { id: task.id, items: ["Write\nit", "Ship"] }),
	).items;
	unwrap(await Checklist.tick(base, { items: [`${label}.1`] }));
	expect(unwrap(await Checklist.progress(base))).toEqual(
		new Map([[task.id, { done: 1, total: 2 }]]),
	);
	const page = unwrap(
		await Planner.getContextPage(base, task.id, {
			sections: ["checklist.items"],
		}),
	);
	expect(page.markdown).toContain(
		`## Checklist 1/2\n\n- [x] ${label}.1 Write it id:${first?.id}\n- [ ] ${label}.2 Ship id:`,
	);
	const brief = unwrap(await Planner.assembleContext(base, task.id));
	expect(brief.indexOf("## Checklist")).toBeGreaterThan(
		brief.indexOf("## Description"),
	);
	expect(unwrap(await Planner.assembleContext(base, empty.id))).not.toContain(
		"## Checklist",
	);
});

it("inherits private visibility and never captures private items", async () => {
	const task = await issue();
	unwrap(
		await withDb(base, (db) =>
			db.run("UPDATE planner_tasks SET visibility = 'private' WHERE id = ?", [
				task.id,
			]),
		),
	);
	const [item] = unwrap(
		await Checklist.add(base, { id: task.id, items: ["Secret"] }),
	).items;
	unwrap(await Checklist.tick(base, { items: [item?.id ?? ""] }));
	expect(item?.visibility).toBe("private");
	expect(await ops()).toHaveLength(0);
});

it("goes with its task: a delete captures the items' deletes first", async () => {
	const task = await issue();
	unwrap(await Checklist.add(base, { id: task.id, items: ["Gone"] }));
	unwrap(await Planner.deleteTask(base, task.id));
	expect((await ops()).map((op) => op.op)).toEqual(["insert", "delete"]);
	expect(unwrap(await Checklist.progress(base)).size).toBe(0);
});
