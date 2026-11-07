// A host that registers neither data module (the CLI registers both) has no `task_questions` or
// `task_checklist_items` table: the board reads no decisions or items there, and no read fails for it.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checklist, checklistModule } from "@cabane/checklist";
import { Planner, Runtime } from "@cabane/core";
import { Questions, questionsModule } from "@cabane/questions";
import { SqliteDb } from "@cabane/sqlite";
import { BoardData } from "./data";
import { dropDb, freshDb } from "./test-db";

const BASE = join(tmpdir(), `cabane-board-no-questions-${crypto.randomUUID()}`);

beforeAll(async () => {
	Runtime.configure({ provider: SqliteDb.provider() });
	await freshDb(BASE);
});

afterAll(() => {
	dropDb(BASE);
	// Back to the wiring every other board test shares (test-db.ts).
	Runtime.configure({
		provider: SqliteDb.provider(),
		modules: [questionsModule, checklistModule],
	});
});

it("counts no decisions or items and loads a task's detail without them", async () => {
	const task = await Planner.addTask(BASE, {
		title: "No module here",
		kind: "issue",
	});
	if (!task.ok) throw task.error;
	// The premise: reading the module's table here fails.
	expect((await Questions.list(BASE, { status: "open" })).ok).toBe(false);
	expect((await Checklist.progress(BASE)).ok).toBe(false);
	const counts = await BoardData.openQuestionCounts(BASE);
	expect(counts).toEqual({ ok: true, value: new Map() });
	const progress = await BoardData.checklistProgress(BASE);
	expect(progress).toEqual({ ok: true, value: new Map() });
	const detail = await BoardData.taskDetail(BASE, task.value.id);
	expect(detail.ok && detail.value.questions).toEqual([]);
	expect(detail.ok && detail.value.checklist).toEqual([]);
	const stamp = await BoardData.detailStamp(BASE, task.value.id);
	expect(stamp.ok).toBe(true);
});
