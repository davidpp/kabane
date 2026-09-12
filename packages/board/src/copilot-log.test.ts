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

const PROMPT = "split this into subtasks";

// The first turn of a fresh session.
const started = (prompt = PROMPT, at = T0): CopilotLog.Log =>
	CopilotLog.start(null, prompt, at);

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

// Everything the event view would read back through the port, in order.
const transcript = async (
	log: CopilotLog.Log,
	afterSeq = 0,
): Promise<[number, string, string][]> => {
	const source = CopilotLog.source({ load: async () => ok([]) }, () => log);
	const page = await source.events?.(CopilotLog.CARD_ID, afterSeq);
	if (!page?.ok) throw new Error("events failed");
	return page.value.map((e) => [e.seq, e.type, e.summary]);
};

describe("CopilotLog", () => {
	it("starts as one running card whose transcript opens with the prompt", async () => {
		const log = started();
		expect(log.past).toEqual([]);
		expect(log.current.card).toMatchObject({
			id: "copilot",
			kind: "copilot",
			status: "running",
			startedAt: T0,
			hasEvents: true,
		});
		expect(await transcript(log)).toEqual([[1, "prompt", PROMPT]]);
		expect(log.current.plan).toEqual([]);
		expect(log.current.activity).toBe("thinking");
	});

	it("appends each update as a numbered event, mapping tool_call to the event view's tool_use", async () => {
		let log = started();
		log = CopilotLog.apply(log, update("thought", "looking at JCAB-31"));
		log = CopilotLog.apply(log, update("tool_call", "cabane_context"));
		log = CopilotLog.apply(log, update("tool_result", "ok"));
		log = CopilotLog.apply(
			log,
			update("text", "Two of these are stale.\nDetails…"),
		);
		expect(await transcript(log)).toEqual([
			[1, "prompt", PROMPT],
			[2, "thought", "looking at JCAB-31"],
			[3, "tool_use", "cabane_context"],
			[4, "tool_result", "ok"],
			[5, "text", "Two of these are stale.\nDetails…"],
		]);
		expect(log.current.activity).toBe("cabane_context");
		// One entry per message, its first line: recent headlines for the panel, and the footer
		// flash still means "what it just said". The whole text is in the transcript.
		expect(log.current.tail).toEqual(["Two of these are stale."]);
		expect(log.current.card.status).toBe("running");
	});

	it("done completes the card without an event; error fails it with the reason", async () => {
		const done = CopilotLog.apply(started(), update("done", ""));
		expect(done.current.card).toMatchObject({
			status: "completed",
			finishedAt: T1,
		});
		expect(await transcript(done, 1)).toEqual([]);
		const failed = CopilotLog.apply(
			started(),
			update("error", "harness exited"),
		);
		expect(failed.current.card).toMatchObject({
			status: "failed",
			finishedAt: T1,
			error: "harness exited",
		});
		expect(await transcript(failed, 1)).toEqual([
			[2, "error", "harness exited"],
		]);
	});

	it("cancelled ends the card as failed with that reason", () => {
		const log = CopilotLog.cancelled(started(), T1);
		expect(log.current.card).toMatchObject({
			status: "failed",
			error: "cancelled",
		});
	});

	it("footer: spinner and the last tool while running, ✓ and the last prose line when done, ✗ and the reason on failure", () => {
		let log = started();
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
		const silent = CopilotLog.apply(started(), update("done", ""));
		expect(CopilotLog.footer(silent, "⠹").text).toBe("✓ copilot · done");
		const failed = CopilotLog.apply(started(), update("error", "cancelled"));
		expect(CopilotLog.footer(failed, "⠹")).toEqual({
			text: "✗ copilot · cancelled",
			tone: "error",
		});
	});

	it("footer keeps a multi-line failure to its first line, and the card keeps the whole of it", () => {
		const log = CopilotLog.apply(
			started(),
			update(
				"error",
				"npm error code ETARGET\nACP connection closed\nnpm error notarget No matching version found",
			),
		);
		expect(CopilotLog.footer(log, "⠹").text).toBe(
			"✗ copilot · npm error code ETARGET",
		);
		// The event view reads the card, so nothing is lost for the reader who opens it.
		expect(log.current.card.error).toContain("No matching version found");
	});

	it("a plan replaces the last one and never lands in the transcript", async () => {
		let log = CopilotLog.apply(started(), update("tool_call", "ls"));
		log = CopilotLog.apply(log, planUpdate(PLAN));
		expect(log.current.plan).toEqual(PLAN);
		expect(await transcript(log, 1)).toEqual([[2, "tool_use", "ls"]]);
		// The harness re-sends the whole list as entries move, so the second one stands alone.
		const advanced: readonly PlanEntry[] = [
			{ content: "read the issue", status: "completed" },
			{ content: "and one more", status: "pending" },
		];
		log = CopilotLog.apply(log, planUpdate(advanced));
		expect(log.current.plan).toEqual(advanced);
		expect(await transcript(log, 1)).toEqual([[2, "tool_use", "ls"]]);
	});

	it("progress counts completed entries, and is absent without a plan", () => {
		expect(CopilotLog.progress([])).toBeNull();
		expect(CopilotLog.progress(PLAN)).toEqual({ done: 2, total: 5 });
	});

	it("footer counts the plan while running, and says nothing extra without one", () => {
		let log = CopilotLog.apply(started(), update("tool_call", "cabane_add"));
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

	it("a second turn is appended behind the first, not written over it", async () => {
		let log = CopilotLog.apply(
			started(),
			update("text", "Done: three of them."),
		);
		log = CopilotLog.apply(log, update("done", ""));
		log = CopilotLog.start(log, "now link the blockers", T1);
		log = CopilotLog.apply(log, update("tool_call", "cabane_link"));

		expect(log.past.map((t) => t.prompt)).toEqual([PROMPT]);
		expect(log.current.prompt).toBe("now link the blockers");
		// The first answer is still readable, under the question that asked for it.
		expect(await transcript(log)).toEqual([
			[1, "prompt", PROMPT],
			[2, "text", "Done: three of them."],
			[3, "prompt", "now link the blockers"],
			[4, "tool_use", "cabane_link"],
		]);
		// Seqs run across the whole log, so the view's "everything after what I have" still works.
		expect(await transcript(log, 2)).toEqual([
			[3, "prompt", "now link the blockers"],
			[4, "tool_use", "cabane_link"],
		]);
		// Each turn keeps its own plan and outcome: the first one's is not the current one's.
		expect(log.past[0]?.card.status).toBe("completed");
		expect(log.current.card.status).toBe("running");
		expect(log.current.plan).toEqual([]);
	});

	it("keeps the last few turns and drops the oldest — a session buffer, not a history", () => {
		let log = started("q1");
		for (const prompt of ["q2", "q3", "q4", "q5", "q6", "q7"]) {
			log = CopilotLog.apply(log, update("done", ""));
			log = CopilotLog.start(log, prompt, T1);
		}
		expect([...log.past, log.current].map((t) => t.prompt)).toEqual([
			"q3",
			"q4",
			"q5",
			"q6",
			"q7",
		]);
	});

	it("footer reads the current turn, not the one that finished before it", () => {
		let log = CopilotLog.apply(
			started(),
			update("text", "Moved two to someday."),
		);
		log = CopilotLog.apply(log, update("done", ""));
		expect(CopilotLog.footer(log, "⠹").text).toBe(
			"✓ copilot · Moved two to someday.",
		);
		log = CopilotLog.start(log, "now link the blockers", T1);
		expect(CopilotLog.footer(log, "⠹")).toEqual({
			text: "⠹ copilot · thinking",
			tone: "running",
		});
	});

	it("withActivity puts the copilot card first, keeps the host's cards and questions, and is a no-op without a log", () => {
		const host = BoardActivity.indexCards([hostCard()]);
		host.questionsByTaskId.set("t1", [
			{ taskId: "t1", sessionId: "s", questionActivityId: "q", question: "?" },
		]);
		expect(CopilotLog.withActivity(host, null)).toBe(host);
		const merged = CopilotLog.withActivity(host, started());
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
			CopilotLog.apply(started(), update("text", "one")),
			update("text", "two"),
		);
		const loaded = await source.load();
		expect(loaded.ok && loaded.value.map((c) => c.id)).toEqual([
			"copilot",
			"r1",
		]);
		const card = await source.card?.("copilot");
		expect(card?.ok && card.value?.status).toBe("running");
		const page = await source.events?.("copilot", 2);
		expect(page?.ok && page.value.map((e) => e.summary)).toEqual(["two"]);
		// Host ids pass straight through.
		const hostEvents = await source.events?.("r1", 0);
		expect(hostEvents?.ok && hostEvents.value[0]?.summary).toBe("r1");
		const hostCardRead = await source.card?.("r1");
		expect(hostCardRead?.ok && hostCardRead.value).toBeNull();
	});
});
