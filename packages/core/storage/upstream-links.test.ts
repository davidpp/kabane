import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft, UpsertUpstreamLinkInput } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-upstream-links");

const createTask = async (title: string): Promise<string> => {
	const draft: TaskDraft = { title, kind: "issue" };
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error("failed to create task");
	return result.value.id;
};

const linkInput = (taskId: string): UpsertUpstreamLinkInput => ({
	taskId,
	provider: "linear",
	externalId: "linear-uuid",
	identifier: "ENG-123",
	url: "https://linear.app/acme/issue/ENG-123/example",
	title: "Example feature",
});

describe("Planner — Private Upstream Links", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("stores and reads a linked issue by task", async () => {
		const taskId = await createTask("Implementation root");
		const added = await Planner.upsertUpstreamLink(
			TEST_BASE,
			linkInput(taskId),
		);

		expect(added.ok).toBe(true);
		if (added.ok) {
			expect(added.value.taskId).toBe(taskId);
			expect(added.value.identifier).toBe("ENG-123");
			expect(added.value.title).toBe("Example feature");
		}

		const links = await Planner.getUpstreamLinksForTask(TEST_BASE, taskId);
		expect(links.ok).toBe(true);
		if (links.ok) expect(links.value).toHaveLength(1);
	});

	it("returns no summaries without opening storage for an empty request", async () => {
		const summaries = await Planner.getUpstreamSummariesForTasks(
			join(TEST_BASE, "not-initialized"),
			[],
		);

		expect(summaries).toEqual({ ok: true, value: [] });
	});

	it("returns summaries only for requested task ids", async () => {
		const requestedTaskId = await createTask("Requested implementation root");
		const otherTaskId = await createTask("Other implementation root");
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(requestedTaskId));
		await Planner.upsertUpstreamLink(TEST_BASE, {
			...linkInput(otherTaskId),
			identifier: "ENG-456",
			externalId: "other-linear-uuid",
		});

		const summaries = await Planner.getUpstreamSummariesForTasks(TEST_BASE, [
			requestedTaskId,
		]);

		expect(summaries.ok).toBe(true);
		if (summaries.ok) {
			expect(summaries.value).toEqual([
				{
					taskId: requestedTaskId,
					provider: "linear",
					identifier: "ENG-123",
				},
			]);
		}
	});

	it("returns summaries for multiple requested tasks in one batch", async () => {
		const firstTaskId = await createTask("First implementation root");
		const secondTaskId = await createTask("Second implementation root");
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(firstTaskId));
		await Planner.upsertUpstreamLink(TEST_BASE, {
			...linkInput(secondTaskId),
			identifier: "ENG-456",
			externalId: "second-linear-uuid",
		});

		const summaries = await Planner.getUpstreamSummariesForTasks(TEST_BASE, [
			firstTaskId,
			secondTaskId,
		]);

		expect(summaries.ok).toBe(true);
		if (summaries.ok) {
			expect(summaries.value).toHaveLength(2);
			expect(summaries.value.map((summary) => summary.taskId).sort()).toEqual(
				[firstTaskId, secondTaskId].sort(),
			);
		}
	});

	it("preserves multiple upstream links for one implementation root", async () => {
		const taskId = await createTask("Multi-provider implementation root");
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(taskId));
		await Planner.upsertUpstreamLink(TEST_BASE, {
			...linkInput(taskId),
			provider: "github",
			identifier: "acme/jake#42",
			externalId: "github-issue-42",
			url: "https://github.com/acme/jake/issues/42",
		});

		const summaries = await Planner.getUpstreamSummariesForTasks(TEST_BASE, [
			taskId,
		]);

		expect(summaries.ok).toBe(true);
		if (summaries.ok) {
			expect(summaries.value).toHaveLength(2);
			expect(summaries.value.map((summary) => summary.provider).sort()).toEqual(
				["github", "linear"],
			);
		}
	});

	it("corrects a link's title without changing its identity", async () => {
		const taskId = await createTask("Implementation root");
		const first = await Planner.upsertUpstreamLink(
			TEST_BASE,
			linkInput(taskId),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		await Bun.sleep(5);
		const second = await Planner.upsertUpstreamLink(TEST_BASE, {
			...linkInput(taskId),
			title: "Updated feature",
		});

		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.value.id).toBe(first.value.id);
			expect(second.value.createdAt).toBe(first.value.createdAt);
			expect(second.value.title).toBe("Updated feature");
			expect(second.value.updatedAt > first.value.updatedAt).toBe(true);
		}

		const links = await Planner.getUpstreamLinksForTask(TEST_BASE, taskId);
		expect(links.ok).toBe(true);
		if (links.ok) expect(links.value).toHaveLength(1);
	});

	it("resolves one external item to multiple private roots", async () => {
		const firstTaskId = await createTask("First implementation root");
		const secondTaskId = await createTask("Second implementation root");

		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(firstTaskId));
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(secondTaskId));

		const links = await Planner.getUpstreamLinksByExternalRef(
			TEST_BASE,
			"linear",
			"linear-uuid",
		);
		expect(links.ok).toBe(true);
		if (links.ok) {
			expect(links.value).toHaveLength(2);
			expect(links.value.map((link) => link.taskId).sort()).toEqual(
				[firstTaskId, secondTaskId].sort(),
			);
		}
	});

	it("removes one local relationship", async () => {
		const taskId = await createTask("Implementation root");
		const added = await Planner.upsertUpstreamLink(
			TEST_BASE,
			linkInput(taskId),
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;

		const removed = await Planner.deleteUpstreamLink(TEST_BASE, added.value.id);
		expect(removed.ok).toBe(true);

		const links = await Planner.getUpstreamLinksForTask(TEST_BASE, taskId);
		expect(links.ok).toBe(true);
		if (links.ok) expect(links.value).toHaveLength(0);
	});

	it("cascades the private relationship when its task is deleted", async () => {
		const taskId = await createTask("Implementation root");
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(taskId));

		const deleted = await Planner.deleteTask(TEST_BASE, taskId);
		expect(deleted.ok).toBe(true);

		const links = await Planner.getUpstreamLinksByExternalRef(
			TEST_BASE,
			"linear",
			"linear-uuid",
		);
		expect(links.ok).toBe(true);
		if (links.ok) expect(links.value).toHaveLength(0);
	});

	it("returns a Result error when the task does not exist", async () => {
		const result = await Planner.upsertUpstreamLink(
			TEST_BASE,
			linkInput("missing-task"),
		);

		expect(result.ok).toBe(false);
	});

	it("auto-creates a stub upstream link for a linear-sourced task with sourceId and URL", async () => {
		const draft: TaskDraft = {
			title: "Linear-sourced task",
			kind: "issue",
			provenance: {
				source: "linear",
				sourceId: "JDEM-52",
				sourceUrl: "https://linear.app/acme/issue/JDEM-52",
				discoveredAt: new Date().toISOString(),
			},
		};
		const taskResult = await Planner.addTask(TEST_BASE, draft);
		expect(taskResult.ok).toBe(true);
		if (!taskResult.ok) return;
		const task = taskResult.value;

		// Simulate what the CLI does after add
		const stubResult = await Planner.upsertUpstreamLink(TEST_BASE, {
			taskId: task.id,
			provider: "linear",
			externalId: "JDEM-52",
			identifier: "JDEM-52",
			url: "https://linear.app/acme/issue/JDEM-52",
			title: task.title,
		});
		expect(stubResult.ok).toBe(true);
		if (!stubResult.ok) return;
		expect(stubResult.value.provider).toBe("linear");
		expect(stubResult.value.externalId).toBe("JDEM-52");

		const links = await Planner.getUpstreamLinksForTask(TEST_BASE, task.id);
		expect(links.ok).toBe(true);
		if (links.ok) expect(links.value).toHaveLength(1);
	});

	it("backfill is idempotent — does not duplicate existing links", async () => {
		const taskId = await createTask("Existing linked task");
		await Planner.upsertUpstreamLink(TEST_BASE, linkInput(taskId));

		// Second upsert with same provider+externalId should not create a new row
		await Planner.upsertUpstreamLink(TEST_BASE, {
			...linkInput(taskId),
			title: "Refreshed title",
		});

		const links = await Planner.getUpstreamLinksForTask(TEST_BASE, taskId);
		expect(links.ok).toBe(true);
		if (links.ok) {
			expect(links.value).toHaveLength(1);
			expect(links.value[0].title).toBe("Refreshed title");
		}
	});
});
