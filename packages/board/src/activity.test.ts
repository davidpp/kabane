import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { err, formatQuestionBody, ok, Planner } from "@cabane/core";
import { BoardActivity } from "./activity";
import { type ActivityCard, type ActivitySource, noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";

const TEST_BASE = join(import.meta.dir, ".test-activity");

const card = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "c1",
	kind: "runs",
	label: "scout",
	status: "running",
	startedAt: new Date().toISOString(),
	detail: [],
	...over,
});

// A stub host: whatever cards the test hands it.
const sourceOf = (cards: ActivityCard[]): ActivitySource => ({
	load: async () => ok(cards),
});

describe("BoardActivity.indexCards (pure)", () => {
	it("keeps every card in order and indexes only in-flight ones by task id and shortId", () => {
		const cards = [
			card({ id: "a", taskId: "t1" }),
			card({ id: "b", taskShortId: "JAKE-1", status: "paused" }),
			card({ id: "c", taskId: "t1", status: "completed" }),
			card({ id: "d", taskId: "t2", taskShortId: "JAKE-2", status: "pending" }),
			card({ id: "e", status: "failed" }),
		];
		const activity = BoardActivity.indexCards(cards);
		expect(activity.cards.map((c) => c.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(activity.inFlightByTaskId.get("t1")?.map((c) => c.id)).toEqual([
			"a",
		]);
		expect(activity.inFlightByTaskId.get("t2")?.map((c) => c.id)).toEqual([
			"d",
		]);
		expect(activity.inFlightByShortId.get("JAKE-1")?.map((c) => c.id)).toEqual([
			"b",
		]);
		expect(activity.inFlightByShortId.get("JAKE-2")?.map((c) => c.id)).toEqual([
			"d",
		]);
		expect(activity.questionsByTaskId.size).toBe(0);
	});

	it("emptyActivity has nothing in it", () => {
		const empty = BoardActivity.emptyActivity();
		expect(empty.cards).toEqual([]);
		expect(empty.inFlightByTaskId.size).toBe(0);
		expect(empty.inFlightByShortId.size).toBe(0);
		expect(empty.questionsByTaskId.size).toBe(0);
	});
});

describe("BoardActivity.inFlightForTask / cardsForTask (pure)", () => {
	const activity = BoardActivity.indexCards([
		card({ id: "run-live", taskId: "t1" }),
		card({
			id: "loop-live",
			kind: "loops",
			label: "loop",
			taskShortId: "JAKE-1",
		}),
		card({
			id: "both",
			taskId: "t1",
			taskShortId: "JAKE-1",
			status: "pending",
		}),
		card({ id: "run-done", taskId: "t1", status: "completed" }),
		card({ id: "run-failed", taskId: "t1", status: "failed" }),
		card({ id: "other", taskId: "t2" }),
		card({
			id: "loop-done",
			kind: "loops",
			taskShortId: "JAKE-1",
			status: "completed",
		}),
	]);

	it("inFlightForTask unions the id and shortId matches, deduped by card id", () => {
		expect(
			BoardActivity.inFlightForTask(activity, "t1", "JAKE-1").map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live"]);
		expect(
			BoardActivity.inFlightForTask(activity, "t1").map((c) => c.id),
		).toEqual(["run-live", "both"]);
	});

	it("cardsForTask lists in-flight first, then recent finished ones, capped", () => {
		expect(
			BoardActivity.cardsForTask(activity, "t1", "JAKE-1").map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live", "run-done", "run-failed"]);
		expect(
			BoardActivity.cardsForTask(activity, "t1", "JAKE-1", 4).map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live", "run-done"]);
	});

	it("cardsForTask returns an empty array when nothing matches", () => {
		expect(BoardActivity.cardsForTask(activity, "nope")).toEqual([]);
	});

	it("anyRunning is true only for a live running or pending card", () => {
		expect(BoardActivity.anyRunning(activity)).toBe(true);
		expect(
			BoardActivity.anyRunning(
				BoardActivity.indexCards([card({ status: "completed" })]),
			),
		).toBe(false);
		expect(
			BoardActivity.anyRunning(
				BoardActivity.indexCards([card({ stale: true })]),
			),
		).toBe(false);
		expect(
			BoardActivity.anyRunning(
				BoardActivity.indexCards([card({ status: "paused" })]),
			),
		).toBe(false);
	});
});

describe("BoardActivity.loadActivity", () => {
	beforeEach(async () => {
		await freshDb(TEST_BASE);
	});

	afterEach(() => {
		dropDb(TEST_BASE);
	});

	it("returns empty maps when nothing is in flight", async () => {
		const result = await BoardActivity.loadActivity(TEST_BASE, noActivity);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cards).toEqual([]);
		expect(result.value.questionsByTaskId.size).toBe(0);
	});

	it("indexes the source's cards", async () => {
		const result = await BoardActivity.loadActivity(
			TEST_BASE,
			sourceOf([card({ id: "a", taskId: "t1" })]),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cards.map((c) => c.id)).toEqual(["a"]);
		expect(result.value.inFlightByTaskId.get("t1")?.length).toBe(1);
	});

	it("a failing source degrades to no cards instead of failing the whole read", async () => {
		const broken: ActivitySource = {
			load: async () => err(new Error("host down")),
		};
		const result = await BoardActivity.loadActivity(TEST_BASE, broken);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cards).toEqual([]);
	});

	it("maps unanswered questions by task id with parsed question text", async () => {
		const added = await Planner.addTask(TEST_BASE, {
			title: "Agent work",
			kind: "issue",
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const started = await Planner.startSession(TEST_BASE, {
			taskId: added.value.id,
			agent: "claude",
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		// Body carries the json metadata fence — the seam must strip it down to the question text.
		const activity = await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "question",
			context: "why we're asking",
			body: formatQuestionBody("Redis or in-memory?", {
				choices: ["Redis", "In-memory"],
			}),
		});
		expect(activity.ok).toBe(true);
		if (!activity.ok) return;

		const result = await BoardActivity.loadActivity(TEST_BASE, noActivity);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const questions = result.value.questionsByTaskId.get(added.value.id);
		expect(questions).toHaveLength(1);
		expect(questions?.[0]?.question).toBe("Redis or in-memory?");
		expect(questions?.[0]?.sessionId).toBe(started.value.id);
		expect(questions?.[0]?.questionActivityId).toBe(activity.value.id);
	});

	it("groups multiple unanswered questions under the same task", async () => {
		const added = await Planner.addTask(TEST_BASE, {
			title: "Batch",
			kind: "issue",
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const started = await Planner.startSession(TEST_BASE, {
			taskId: added.value.id,
			agent: "claude",
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		for (const q of ["Q1?", "Q2?"]) {
			await Planner.addActivity(TEST_BASE, {
				sessionId: started.value.id,
				type: "question",
				body: q,
			});
		}

		const result = await BoardActivity.loadActivity(TEST_BASE, noActivity);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(
			result.value.questionsByTaskId
				.get(added.value.id)
				?.map((q) => q.question),
		).toEqual(["Q1?", "Q2?"]);
	});
});
