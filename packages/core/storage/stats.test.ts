import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withDb } from "../runtime";

import type { TaskDraft } from "../schemas";
import { TABLES } from "./helpers";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-stats");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Backdate a task's created_at to `daysAgo` days in the past. */
const backdateCreatedAt = async (taskId: string, daysAgo: number) => {
	const iso = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
	await withDb(TEST_BASE, (db) => {
		db.run(`UPDATE ${TABLES.tasks} SET created_at = ? WHERE id = ?`, [
			iso,
			taskId,
		]);
	});
};

const addTask = async (draft: TaskDraft): Promise<string> => {
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error(`addTask failed: ${result.error.message}`);
	return result.value.id;
};

describe("Planner — Stats (health digest)", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("returns zeroed health fields on an empty planner", async () => {
		const result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.oldestInboxDays).toBe(0);
		expect(result.value.staleInProgressCount).toBe(0);
		expect(result.value.inboxOver30d).toBe(0);
		expect(result.value.probablyDoneCount).toBe(0);
	});

	it("computes oldestInboxDays from the oldest inbox task", async () => {
		await addTask({ title: "fresh" });
		const old = await addTask({ title: "old" });
		await backdateCreatedAt(old, 45);

		const result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.oldestInboxDays).toBe(45);
		expect(result.value.inboxOver30d).toBe(1);
	});

	it("only counts inbox tasks toward inboxOver30d", async () => {
		const done = await addTask({ title: "done long ago", state: "done" });
		await backdateCreatedAt(done, 60);

		const result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.inboxOver30d).toBe(0);
		expect(result.value.oldestInboxDays).toBe(0);
	});

	it("counts stale in-progress issues untouched over 7 days", async () => {
		const stale = await addTask({
			title: "stuck issue",
			kind: "issue",
			state: "in_progress",
		});
		await backdateCreatedAt(stale, 10);
		// updated_at also drives staleness; backdate it too.
		await withDb(TEST_BASE, (db) => {
			const iso = new Date(Date.now() - 10 * DAY_MS).toISOString();
			db.run(`UPDATE ${TABLES.tasks} SET updated_at = ? WHERE id = ?`, [
				iso,
				stale,
			]);
		});

		const result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.staleInProgressCount).toBe(1);
	});

	it("counts open tasks with a commit: work-log ref as probably done", async () => {
		const id = await addTask({
			title: "shipped but open",
			kind: "issue",
			state: "in_progress",
		});
		const logResult = await Planner.addWorkLog(TEST_BASE, {
			taskId: id,
			refs: [{ uri: "commit:abc1234", label: "fix" }],
		});
		expect(logResult.ok).toBe(true);

		let result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.probablyDoneCount).toBe(1);

		// Closing the task removes it from the bucket.
		const doneResult = await Planner.updateTask(TEST_BASE, id, {
			state: "done",
		});
		expect(doneResult.ok).toBe(true);

		result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.probablyDoneCount).toBe(0);
	});

	it("ignores non-commit work-log refs for probablyDoneCount", async () => {
		const id = await addTask({
			title: "has a session ref only",
			kind: "issue",
			state: "in_progress",
		});
		await Planner.addWorkLog(TEST_BASE, {
			taskId: id,
			refs: [{ uri: "session:xyz789" }],
		});

		const result = await Planner.stats(TEST_BASE);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.probablyDoneCount).toBe(0);
	});
});
