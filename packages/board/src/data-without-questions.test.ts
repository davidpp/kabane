// A host that registers none of the data modules (the CLI registers them all) has no `task_questions`
// or `task_checklist_items` table and declares no entry kind: the board reads no decisions or items
// there, lifts no entry under the description, and no read fails for it.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checklist, checklistModule } from "@cabane/checklist";
import { Planner, Runtime } from "@cabane/core";
import { handoffModule } from "@cabane/handoff";
import { Questions, questionsModule } from "@cabane/questions";
import { SqliteDb } from "@cabane/sqlite";
import { BoardData } from "./data";
import { DetailModel } from "./detail-model";
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
		modules: [questionsModule, handoffModule, checklistModule],
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
	const handoff = await Planner.addEntry(BASE, {
		taskId: task.value.id,
		kind: "handoff",
		author: "cabane://actor/agent/claude",
		authorType: "ai",
		content: "written by a host that declares the kind",
	});
	if (!handoff.ok) throw handoff.error;
	const detail = await BoardData.taskDetail(BASE, task.value.id);
	if (!detail.ok) throw detail.error;
	expect(detail.value.questions).toEqual([]);
	expect(detail.value.checklist).toEqual([]);
	expect(detail.value.kinds).toEqual([]);
	expect(DetailModel.lifted(detail.value)).toEqual([]);
	expect(DetailModel.timeline(detail.value).map((e) => e.kind)).toEqual([
		"handoff",
	]);
	const stamp = await BoardData.detailStamp(BASE, task.value.id);
	expect(stamp.ok).toBe(true);
});
