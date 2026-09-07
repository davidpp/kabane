import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
	ImplementationResultSchema,
	ImplementationSelectorSchema,
} from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-implementation");

const createTask = async (
	title: string,
	input: {
		parentTaskId?: string;
		state?: "next" | "in_progress" | "done";
	} = {},
) => {
	const result = await Planner.addTask(TEST_BASE, {
		title,
		kind: "issue",
		...input,
	});
	if (!result.ok) throw result.error;
	return result.value;
};

const awaitInput = async (taskId: string, questions = 1): Promise<string> => {
	const session = await Planner.startSession(TEST_BASE, {
		taskId,
		agent: "test-agent",
	});
	if (!session.ok) throw session.error;
	for (let index = 0; index < questions; index++) {
		const activity = await Planner.addActivity(TEST_BASE, {
			sessionId: session.value.id,
			type: "question",
			context: "Need a decision",
			body: `Question ${index + 1}`,
		});
		if (!activity.ok) throw activity.error;
	}
	return session.value.id;
};

const link = async (taskId: string, externalId = "linear-uuid") => {
	const result = await Planner.upsertUpstreamLink(TEST_BASE, {
		taskId,
		provider: "linear",
		externalId,
		identifier: "ENG-123",
		url: "https://linear.app/acme/issue/ENG-123/example",
		title: "Team feature",
		state: "In Progress",
	});
	if (!result.ok) throw result.error;
	return result.value;
};

describe("Planner — composed implementation view", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("returns one task-selected view without requiring an upstream link", async () => {
		const root = await createTask("Local root");
		const result = await Planner.implementation(TEST_BASE, {
			taskId: root.shortId ?? root.id,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.implementations).toHaveLength(1);
		expect(result.value.implementations[0].rootTask.id).toBe(root.id);
		expect(result.value.implementations[0].upstreamLinks).toEqual([]);
		expect(result.value.implementations[0].rollup).toEqual({
			total: 0,
			done: 0,
			active: 0,
			needsInput: 0,
		});
		expect(ImplementationResultSchema.safeParse(result.value).success).toBe(
			true,
		);
	});

	it("rolls up direct subtasks and unique awaiting-input sessions only", async () => {
		const root = await createTask("Root");
		const active = await createTask("Active child", {
			parentTaskId: root.id,
			state: "in_progress",
		});
		await createTask("Done child", {
			parentTaskId: root.id,
			state: "done",
		});
		const nested = await createTask("Nested child", {
			parentTaskId: active.id,
			state: "in_progress",
		});
		await awaitInput(root.id, 2);
		await awaitInput(active.id);
		await awaitInput(nested.id);

		const result = await Planner.implementation(TEST_BASE, { taskId: root.id });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const view = result.value.implementations[0];
		expect(view.subtasks.map((task) => task.title).sort()).toEqual([
			"Active child",
			"Done child",
		]);
		expect(view.rollup).toEqual({
			total: 2,
			done: 1,
			active: 1,
			needsInput: 2,
		});
	});

	it("returns every private root for an external selector", async () => {
		const first = await createTask("First root");
		const second = await createTask("Second root");
		await link(first.id);
		await link(second.id);

		const result = await Planner.implementation(TEST_BASE, {
			provider: "linear",
			externalId: "linear-uuid",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.implementations.map((view) => view.rootTask.id),
		).toEqual([first.id, second.id]);
	});

	it("returns an empty list for an unmatched external selector", async () => {
		const result = await Planner.implementation(TEST_BASE, {
			provider: "linear",
			externalId: "missing",
		});
		expect(result).toEqual({ ok: true, value: { implementations: [] } });
	});

	it("rejects mixed, partial, and extra selector fields", () => {
		expect(
			ImplementationSelectorSchema.safeParse({
				taskId: "JJAK-1",
				provider: "linear",
				externalId: "uuid",
			}).success,
		).toBe(false);
		expect(
			ImplementationSelectorSchema.safeParse({ provider: "linear" }).success,
		).toBe(false);
		expect(
			ImplementationSelectorSchema.safeParse({
				taskId: "JJAK-1",
				extra: true,
			}).success,
		).toBe(false);
	});
});
