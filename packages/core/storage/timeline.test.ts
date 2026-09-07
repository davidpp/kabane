import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-timeline");

const draft: TaskDraft = { title: "Timeline task", kind: "issue" };

const createTask = async (): Promise<string> => {
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error("failed to create task");
	return result.value.id;
};

describe("Planner — getTimeline (S4a)", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("merges comments, work logs, and agent sessions", async () => {
		const taskId = await createTask();

		await Planner.addComment(TEST_BASE, {
			taskId,
			author: "taylor",
			authorType: "human",
			content: "a comment",
		});
		await Planner.addWorkLog(TEST_BASE, {
			taskId,
			refs: [{ uri: "commit:abc123" }],
		});
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");

		const result = await Planner.getTimeline(TEST_BASE, taskId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Exactly these three types — the 'activity' branch was dropped (S4a).
		const types = result.value.map((e) => e.type).sort();
		expect(types).toEqual(["comment", "session", "worklog"]);
	});

	it("anchors session entries at startedAt and sorts chronologically", async () => {
		const taskId = await createTask();

		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");

		// A later comment should sort after the session (which anchors at startedAt).
		await new Promise((r) => setTimeout(r, 5));
		await Planner.addComment(TEST_BASE, {
			taskId,
			author: "taylor",
			authorType: "human",
			content: "after the session",
		});

		const result = await Planner.getTimeline(TEST_BASE, taskId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value[0].type).toBe("session");
		const sessionEntry = result.value[0];
		if (sessionEntry.type !== "session") throw new Error("expected session");
		expect(sessionEntry.data.startedAt).toBe(started.value.startedAt);
		expect(result.value[1].type).toBe("comment");
	});

	it("folds session entries with a card by default", async () => {
		const taskId = await createTask();
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "finding",
			severity: "P1",
			body: "a P1 finding",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "response",
			body: "the final answer",
		});

		const result = await Planner.getTimeline(TEST_BASE, taskId);
		if (!result.ok) throw new Error("timeline failed");
		const entry = result.value.find((e) => e.type === "session");
		if (entry?.type !== "session") throw new Error("expected session entry");
		expect(entry.card).toBeDefined();
		expect(entry.card?.finalResponse).toBe("the final answer");
		expect(entry.card?.findingCounts.P1).toBe(1);
		expect(entry.card?.activityCount).toBe(2);
	});

	it("omits the card when fold is false", async () => {
		const taskId = await createTask();
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "response",
			body: "hi",
		});

		const result = await Planner.getTimeline(TEST_BASE, taskId, {
			fold: false,
		});
		if (!result.ok) throw new Error("timeline failed");
		const entry = result.value.find((e) => e.type === "session");
		if (entry?.type !== "session") throw new Error("expected session entry");
		expect(entry.card).toBeUndefined();
	});

	it("paginates with limit/offset over the sorted list", async () => {
		const taskId = await createTask();
		for (const n of ["one", "two", "three"]) {
			await Planner.addComment(TEST_BASE, {
				taskId,
				author: "me",
				authorType: "human",
				content: n,
			});
			await new Promise((r) => setTimeout(r, 5));
		}

		const page = await Planner.getTimeline(TEST_BASE, taskId, {
			limit: 1,
			offset: 1,
		});
		if (!page.ok) throw new Error("timeline failed");
		expect(page.value).toHaveLength(1);
		const entry = page.value[0];
		if (entry.type !== "comment") throw new Error("expected comment");
		expect(entry.data.content).toBe("two");
	});
});

describe("Planner — assembleDigest (S5)", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("renders durable activities grouped by session, excludes ephemera", async () => {
		const taskId = await createTask();
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "progress",
			ephemeral: true,
			body: "SPINNER_NOISE",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "finding",
			severity: "P2",
			body: "a real finding",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "response",
			body: "final response",
		});

		const result = await Planner.assembleDigest(TEST_BASE, taskId);
		if (!result.ok) throw new Error("digest failed");
		expect(result.value).toContain("## claude — active");
		expect(result.value).toContain("[finding/P2]");
		expect(result.value).toContain("a real finding");
		expect(result.value).toContain("final response");
		expect(result.value).not.toContain("SPINNER_NOISE");
	});

	it("returns a placeholder when there is no durable activity", async () => {
		const taskId = await createTask();
		const result = await Planner.assembleDigest(TEST_BASE, taskId);
		if (!result.ok) throw new Error("digest failed");
		expect(result.value).toBe("_No durable agent activity._");
	});
});
