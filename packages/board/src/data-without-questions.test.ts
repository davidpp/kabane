// A host that does not register the questions module (the CLI does) has no `task_questions` table:
// the board reads no decisions there, and no read fails for it.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		modules: [questionsModule],
	});
});

it("counts no decisions and loads a task's detail without them", async () => {
	const task = await Planner.addTask(BASE, {
		title: "No module here",
		kind: "issue",
	});
	if (!task.ok) throw task.error;
	// The premise: reading the module's table here fails.
	expect((await Questions.list(BASE, { status: "open" })).ok).toBe(false);
	const counts = await BoardData.openQuestionCounts(BASE);
	expect(counts).toEqual({ ok: true, value: new Map() });
	const detail = await BoardData.taskDetail(BASE, task.value.id);
	expect(detail.ok && detail.value.questions).toEqual([]);
	const stamp = await BoardData.detailStamp(BASE, task.value.id);
	expect(stamp.ok).toBe(true);
});
