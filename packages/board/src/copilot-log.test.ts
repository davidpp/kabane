import { describe, expect, it } from "bun:test";
import { ok } from "@cabane/core";
import { BoardActivity } from "./activity";
import { CopilotLog } from "./copilot-log";
import type {
	ActivityCard,
	ActivitySource,
	CopilotStep,
	CopilotUpdate,
	PlanEntry,
} from "./ports";

const T0 = "2026-09-12T10:00:00.000Z";
const T1 = "2026-09-12T10:00:01.000Z";

const update = (
	type: CopilotStep,
	summary: string,
	at = T1,
): CopilotUpdate => ({ type, summary, at });

const planUpdate = (entries: readonly PlanEntry[], at = T1): CopilotUpdate => ({
	type: "plan",
	entries,
	at,
});

const PLAN: readonly PlanEntry[] = [
	{ content: "read the issue", status: "completed" },
	{ content: "propose the split", status: "completed" },
	{ content: "create the subtasks", status: "in_progress" },
	{ content: "link the blockers", status: "pending" },
	{ content: "summarise", status: "pending" },
];

const hostCard = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "r1",
	kind: "runs",
	label: "scout",
	status: "completed",
	startedAt: T0,
	detail: [],
	...over,
});

describe("CopilotLog", () => {
	it("starts as one running card with events to show and nothing said yet", () => {
		const log = CopilotLog.start(T0);
		expect(log.card).toMatchObject({
			id: "copilot",
			kind: "copilot",
			status: "running",
			startedAt: T0,
			hasEvents: true,
		});
		expect(log.events).toEqual([]);
		expect(log.plan).toEqual([]);
		expect(log.activity).toBe("thinking");
	});

	it("appends each update as a numbered event, mapping tool_call to the event view's tool_use", () => {
		let log = CopilotLog.start(T0);
		log = CopilotLog.apply(log, update("thought", "looking at JCAB-31"));
		log = CopilotLog.apply(log, update("tool_call", "cabane_context"));
		log = CopilotLog.apply(log, update("tool_result", "ok"));
		log = CopilotLog.apply(
			log,
			update("text", "Two of these are stale.\nDetails…"),
		);
		expect(log.events.map((e) => [e.seq, e.type, e.summary])).toEqual([
			[1, "thought", "looking at JCAB-31"],
			[2, "tool_use", "cabane_context"],
			[3, "tool_result", "ok"],
			[4, "text", "Two of these are stale.\nDetails…"],
		]);
		expect(log.activity).toBe("cabane_context");
		// One entry per message, its first line: recent headlines for the panel, and the footer
		// flash still means "what it just said". The whole text is in the transcript.
		expect(log.tail).toEqual(["Two of these are stale."]);
		expect(log.card.status).toBe("running");
	});

	it("done completes the card without an event; error fails it with the reason", () => {
		const done = CopilotLog.apply(CopilotLog.start(T0), update("done", ""));
		expect(done.card).toMatchObject({ status: "completed", finishedAt: T1 });
		expect(done.events).toEqual([]);
		const failed = CopilotLog.apply(
			CopilotLog.start(T0),
			update("error", "harness exited"),
		);
		expect(failed.card).toMatchObject({
			status: "failed",
			finishedAt: T1,
			error: "harness exited",
		});
		expect(failed.events.map((e) => e.type)).toEqual(["error"]);
	});

	it("cancelled ends the card as failed with that reason", () => {
		const log = CopilotLog.cancelled(CopilotLog.start(T0), T1);
		expect(log.card).toMatchObject({ status: "failed", error: "cancelled" });
	});

	it("footer: spinner and the last tool while running, ✓ and the last prose line when done, ✗ and the reason on failure", () => {
		let log = CopilotLog.start(T0);
		expect(CopilotLog.footer(log, "⠹")).toEqual({
			text: "⠹ copilot · thinking",
			tone: "running",
		});
		log = CopilotLog.apply(log, update("tool_call", "cabane_edit"));
		expect(CopilotLog.footer(log, "⠸").text).toBe("⠸ copilot · cabane_edit");
		log = CopilotLog.apply(log, update("text", "Moved two to someday.\nmore"));
		log = CopilotLog.apply(log, update("done", ""));
		expect(CopilotLog.footer(log, "⠹")).toEqual({
			text: "✓ copilot · Moved two to someday.",
			tone: "done",
		});
		const silent = CopilotLog.apply(CopilotLog.start(T0), update("done", ""));
		expect(CopilotLog.footer(silent, "⠹").text).toBe("✓ copilot · done");
		const failed = CopilotLog.apply(
			CopilotLog.start(T0),
			update("error", "cancelled"),
		);
		expect(CopilotLog.footer(failed, "⠹")).toEqual({
			text: "✗ copilot · cancelled",
			tone: "error",
		});
	});

	it("footer keeps a multi-line failure to its first line, and the card keeps the whole of it", () => {
		const log = CopilotLog.apply(
			CopilotLog.start(T0),
			update(
				"error",
				"npm error code ETARGET\nACP connection closed\nnpm error notarget No matching version found",
			),
		);
		expect(CopilotLog.footer(log, "⠹").text).toBe(
			"✗ copilot · npm error code ETARGET",
		);
		// The event view reads the card, so nothing is lost for the reader who opens it.
		expect(log.card.error).toContain("No matching version found");
	});

	it("a plan replaces the last one and never lands in the transcript", () => {
		let log = CopilotLog.apply(CopilotLog.start(T0), update("tool_call", "ls"));
		log = CopilotLog.apply(log, planUpdate(PLAN));
		expect(log.plan).toEqual(PLAN);
		expect(log.events.map((e) => e.type)).toEqual(["tool_use"]);
		// The harness re-sends the whole list as entries move, so the second one stands alone.
		const advanced: readonly PlanEntry[] = [
			{ content: "read the issue", status: "completed" },
			{ content: "and one more", status: "pending" },
		];
		log = CopilotLog.apply(log, planUpdate(advanced));
		expect(log.plan).toEqual(advanced);
		expect(log.events.map((e) => e.type)).toEqual(["tool_use"]);
	});

	it("progress counts completed entries, and is absent without a plan", () => {
		expect(CopilotLog.progress([])).toBeNull();
		expect(CopilotLog.progress(PLAN)).toEqual({ done: 2, total: 5 });
	});

	it("footer counts the plan while running, and says nothing extra without one", () => {
		let log = CopilotLog.apply(
			CopilotLog.start(T0),
			update("tool_call", "cabane_add"),
		);
		expect(CopilotLog.footer(log, "⠹").text).toBe("⠹ copilot · cabane_add");
		log = CopilotLog.apply(log, planUpdate(PLAN));
		expect(CopilotLog.footer(log, "⠹")).toEqual({
			text: "⠹ copilot · 2/5 · cabane_add",
			tone: "running",
		});
		// The count belongs to the running line only — a finished turn reports its outcome.
		log = CopilotLog.apply(log, update("text", "Created three subtasks."));
		log = CopilotLog.apply(log, update("done", ""));
		expect(CopilotLog.footer(log, "⠹").text).toBe(
			"✓ copilot · Created three subtasks.",
		);
	});

	it("withActivity puts the copilot card first, keeps the host's cards and questions, and is a no-op without a log", () => {
		const host = BoardActivity.indexCards([hostCard()]);
		host.questionsByTaskId.set("t1", [
			{ taskId: "t1", sessionId: "s", questionActivityId: "q", question: "?" },
		]);
		expect(CopilotLog.withActivity(host, null)).toBe(host);
		const merged = CopilotLog.withActivity(host, CopilotLog.start(T0));
		expect(merged.cards.map((c) => c.id)).toEqual(["copilot", "r1"]);
		expect(merged.questionsByTaskId.get("t1")?.length).toBe(1);
		expect(BoardActivity.anyRunning(merged)).toBe(true);
	});

	it("source layers the copilot card over the host source and serves its events after a seq", async () => {
		const hostSource: ActivitySource = {
			load: async () => ok([hostCard()]),
			events: async (id) => ok([{ seq: 1, at: T0, type: "text", summary: id }]),
		};
		let log: CopilotLog.Log | null = null;
		const source = CopilotLog.source(hostSource, () => log);
		expect((await source.load()).ok && (await source.load())).toMatchObject({
			value: [hostCard()],
		});
		log = CopilotLog.apply(
			CopilotLog.apply(CopilotLog.start(T0), update("text", "one")),
			update("text", "two"),
		);
		const loaded = await source.load();
		expect(loaded.ok && loaded.value.map((c) => c.id)).toEqual([
			"copilot",
			"r1",
		]);
		const card = await source.card?.("copilot");
		expect(card?.ok && card.value?.status).toBe("running");
		const page = await source.events?.("copilot", 1);
		expect(page?.ok && page.value.map((e) => e.summary)).toEqual(["two"]);
		// Host ids pass straight through.
		const hostEvents = await source.events?.("r1", 0);
		expect(hostEvents?.ok && hostEvents.value[0]?.summary).toBe("r1");
		const hostCardRead = await source.card?.("r1");
		expect(hostCardRead?.ok && hostCardRead.value).toBeNull();
	});
});
