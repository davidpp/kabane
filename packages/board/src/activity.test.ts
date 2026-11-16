import { describe, expect, it } from "bun:test";
import { err, ok } from "@cabane/core";
import {
	type ActivityCard,
	type ActivityQuestion,
	type ActivitySource,
} from "@cabane/extension";
import { BoardActivity } from "./activity";
import { noActivity } from "./ports";

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
			card({ id: "b", taskShortId: "MILL-1", status: "paused" }),
			card({ id: "c", taskId: "t1", status: "completed" }),
			card({ id: "d", taskId: "t2", taskShortId: "MILL-2", status: "pending" }),
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
		expect(activity.inFlightByShortId.get("MILL-1")?.map((c) => c.id)).toEqual([
			"b",
		]);
		expect(activity.inFlightByShortId.get("MILL-2")?.map((c) => c.id)).toEqual([
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
			taskShortId: "MILL-1",
		}),
		card({
			id: "both",
			taskId: "t1",
			taskShortId: "MILL-1",
			status: "pending",
		}),
		card({ id: "run-done", taskId: "t1", status: "completed" }),
		card({ id: "run-failed", taskId: "t1", status: "failed" }),
		card({ id: "other", taskId: "t2" }),
		card({
			id: "loop-done",
			kind: "loops",
			taskShortId: "MILL-1",
			status: "completed",
		}),
	]);

	it("inFlightForTask unions the id and shortId matches, deduped by card id", () => {
		expect(
			BoardActivity.inFlightForTask(activity, "t1", "MILL-1").map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live"]);
		expect(
			BoardActivity.inFlightForTask(activity, "t1").map((c) => c.id),
		).toEqual(["run-live", "both"]);
	});

	it("cardsForTask lists in-flight first, then recent finished ones, capped", () => {
		expect(
			BoardActivity.cardsForTask(activity, "t1", "MILL-1").map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live", "run-done", "run-failed"]);
		expect(
			BoardActivity.cardsForTask(activity, "t1", "MILL-1", 4).map((c) => c.id),
		).toEqual(["run-live", "both", "loop-live", "run-done"]);
	});

	it("cardsForTask returns an empty array when nothing matches", () => {
		expect(BoardActivity.cardsForTask(activity, "nope")).toEqual([]);
	});

	it("eventsCard takes the first in-flight card with events, else the most recent one", () => {
		const cards = [
			card({
				id: "done-events",
				taskId: "t1",
				status: "completed",
				hasEvents: true,
			}),
			card({ id: "live-quiet", taskId: "t1" }),
			card({
				id: "paused-events",
				taskId: "t1",
				status: "paused",
				hasEvents: true,
			}),
			card({
				id: "pending-events",
				taskId: "t1",
				status: "pending",
				hasEvents: true,
			}),
		];
		expect(
			BoardActivity.eventsCard(BoardActivity.indexCards(cards), "t1")?.id,
		).toBe("pending-events");
		expect(
			BoardActivity.eventsCard(
				BoardActivity.indexCards(cards.slice(0, 3)),
				"t1",
			)?.id,
		).toBe("paused-events");
		expect(
			BoardActivity.eventsCard(
				BoardActivity.indexCards(cards.slice(1, 2)),
				"t1",
			),
		).toBeUndefined();
	});

	it("noEvents names an in-flight or open card without a tab, with its last detail line", () => {
		const none = new Map<string, unknown>();
		const quiet = card({
			id: "run",
			taskId: "t1",
			label: "probe",
			detail: ["running", "kabane runs attach run"],
		});
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([quiet]),
				"t1",
				undefined,
				none,
			),
		).toBe("probe has no events here · kabane runs attach run");
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([{ ...quiet, detail: [] }]),
				"t1",
				undefined,
				none,
			),
		).toBe("probe has no events here");
		const idle = { ...quiet, status: "completed" as const };
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([idle]),
				"t1",
				undefined,
				none,
			),
		).toBe("no events");
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([idle]),
				"t1",
				undefined,
				new Map([["run", quiet]]),
			),
		).toBe("probe has no events here · kabane runs attach run");
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([{ ...quiet, tab: true }]),
				"t1",
				undefined,
				none,
			),
		).toBe("no events");
		expect(
			BoardActivity.noEvents(
				BoardActivity.indexCards([]),
				"t1",
				undefined,
				none,
			),
		).toBe("no events");
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
	it("returns empty maps when nothing is in flight", async () => {
		const result = await BoardActivity.loadActivity(noActivity);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cards).toEqual([]);
		expect(result.value.questionsByTaskId.size).toBe(0);
	});

	it("indexes the source's cards", async () => {
		const result = await BoardActivity.loadActivity(
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
		const result = await BoardActivity.loadActivity(broken);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.cards).toEqual([]);
	});

	it("takes questions from the source and indexes them independently of cards", async () => {
		const question: ActivityQuestion = {
			id: "q1",
			cardId: "c1",
			lane: "claude",
			taskId: "t1",
			taskShortId: "T-1",
			question: "Redis or in-memory?",
			choices: ["Redis", "In-memory"],
			multiSelect: false,
			allowFreeform: false,
			asker: "claude",
			askedAt: "2026-10-10T00:00:00Z",
		};
		const result = await BoardActivity.loadActivity({
			load: async () => err(new Error("cards unavailable")),
			questions: async () =>
				ok([
					question,
					{ ...question, id: "q2", askedAt: "2026-10-09T00:00:00Z" },
				]),
		});
		if (!result.ok) throw result.error;
		expect(result.value.questionsByTaskId.get("t1")).toHaveLength(2);
		expect(BoardActivity.questions(result.value).map((q) => q.id)).toEqual([
			"q2",
			"q1",
		]);
		expect(BoardActivity.questions(result.value)[0]).toMatchObject({
			cardId: "c1",
			lane: "claude",
			agent: "claude",
		});
	});

	it("a failed question read keeps the cards", async () => {
		const result = await BoardActivity.loadActivity({
			...sourceOf([card()]),
			questions: async () => err(new Error("questions unavailable")),
		});
		if (!result.ok) throw result.error;
		expect(result.value.cards).toHaveLength(1);
		expect(BoardActivity.questions(result.value)).toEqual([]);
	});

	it("keeps a card's question even without a task", async () => {
		const result = await BoardActivity.loadActivity({
			...sourceOf([card()]),
			questions: async () =>
				ok([
					{
						id: "q",
						cardId: "c1",
						question: "Continue?",
						choices: [],
						multiSelect: false,
						allowFreeform: true,
						asker: "claude",
						askedAt: "2026-10-10T00:00:00Z",
					},
				]),
		});
		if (!result.ok) throw result.error;
		expect(BoardActivity.questions(result.value).map((q) => q.id)).toEqual([
			"q",
		]);
	});
});
