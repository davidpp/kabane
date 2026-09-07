import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-context-refs");

const draft: TaskDraft = { title: "Context registry", kind: "issue" };

/** Create an issue and return its id. */
const createTask = async (): Promise<string> => {
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error("failed to create task");
	return result.value.id;
};

describe("Planner — Context Refs", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("adds a context ref and reads it back", async () => {
		const taskId = await createTask();
		const added = await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "obsidian:prds/foo.md",
			kind: "PRD",
			label: "Foo PRD",
		});
		expect(added.ok).toBe(true);
		if (added.ok) {
			expect(added.value.id).toBeTruthy();
			expect(added.value.uri).toBe("obsidian:prds/foo.md");
			expect(added.value.kind).toBe("PRD");
			expect(added.value.addedAt).toBeTruthy();
		}

		const list = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(list.ok).toBe(true);
		if (list.ok) expect(list.value).toHaveLength(1);
	});

	it("upserts on (task_id, uri) conflict instead of throwing", async () => {
		const taskId = await createTask();
		const first = await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "obsidian:prds/foo.md",
			kind: "PRD",
			label: "old",
			note: "old note",
		});
		const second = await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "obsidian:prds/foo.md",
			kind: "research",
			label: "new",
			note: "new note",
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);

		const list = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(list.ok).toBe(true);
		if (list.ok) {
			expect(list.value).toHaveLength(1);
			expect(list.value[0]?.kind).toBe("research");
			expect(list.value[0]?.label).toBe("new");
			expect(list.value[0]?.note).toBe("new note");
			// id stays stable across the upsert
			if (first.ok) expect(list.value[0]?.id).toBe(first.value.id);
		}
	});

	it("returns refs ordered by added_at ascending", async () => {
		const taskId = await createTask();
		await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "a:1",
			kind: "doc",
		});
		await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "b:2",
			kind: "doc",
		});
		const list = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(list.ok).toBe(true);
		if (list.ok) {
			expect(list.value.map((r) => r.uri)).toEqual(["a:1", "b:2"]);
		}
	});

	it("cascades context refs when the task is deleted", async () => {
		const taskId = await createTask();
		await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "obsidian:prds/foo.md",
			kind: "PRD",
		});

		const del = await Planner.deleteTask(TEST_BASE, taskId);
		expect(del.ok).toBe(true);

		const list = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(list.ok).toBe(true);
		if (list.ok) expect(list.value).toHaveLength(0);
	});

	it("deleteContextRef removes a single ref by id", async () => {
		const taskId = await createTask();
		const added = await Planner.addContextRef(TEST_BASE, {
			taskId,
			uri: "obsidian:prds/foo.md",
			kind: "PRD",
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;

		const del = await Planner.deleteContextRef(TEST_BASE, added.value.id);
		expect(del.ok).toBe(true);

		const list = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(list.ok).toBe(true);
		if (list.ok) expect(list.value).toHaveLength(0);
	});

	it("promoteToContext writes both a work log and a context ref", async () => {
		const taskId = await createTask();
		const promoted = await Planner.promoteToContext(TEST_BASE, {
			taskId,
			uri: "comment:abc",
			kind: "research",
			label: "Analysis",
		});
		expect(promoted.ok).toBe(true);

		const refs = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(refs.ok).toBe(true);
		if (refs.ok) {
			expect(refs.value).toHaveLength(1);
			expect(refs.value[0]?.uri).toBe("comment:abc");
			expect(refs.value[0]?.kind).toBe("research");
		}

		const logs = await Planner.getWorkLogs(TEST_BASE, taskId);
		expect(logs.ok).toBe(true);
		if (logs.ok) {
			expect(logs.value).toHaveLength(1);
			expect(logs.value[0]?.refs[0]?.uri).toBe("comment:abc");
		}
	});

	it("deleteContextRef never touches the work log", async () => {
		const taskId = await createTask();
		const promoted = await Planner.promoteToContext(TEST_BASE, {
			taskId,
			uri: "comment:abc",
			kind: "research",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		await Planner.deleteContextRef(TEST_BASE, promoted.value.id);

		const refs = await Planner.getContextRefs(TEST_BASE, taskId);
		expect(refs.ok).toBe(true);
		if (refs.ok) expect(refs.value).toHaveLength(0);

		// work log survives — rm only touches the registry
		const logs = await Planner.getWorkLogs(TEST_BASE, taskId);
		expect(logs.ok).toBe(true);
		if (logs.ok) expect(logs.value).toHaveLength(1);
	});
});
