import { describe, expect, it } from "bun:test";
import type { AgentActivity, AgentSession } from "../schemas";
import { Planner } from "./select-durable";

let seq = 0;
const activity = (over: Partial<AgentActivity> = {}): AgentActivity => {
	seq += 1;
	return {
		id: `act-${seq}`,
		sessionId: "s1",
		type: "progress",
		ephemeral: false,
		body: `body-${seq}`,
		createdAt: `2026-07-16T00:00:${String(seq).padStart(2, "0")}.000Z`,
		...over,
	};
};

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
	id: "s1",
	taskId: "t1",
	agent: "claude",
	state: "complete",
	startedAt: "2026-07-16T00:00:00.000Z",
	lastActivityAt: "2026-07-16T00:10:00.000Z",
	...over,
});

describe("Planner.selectDurableActivities", () => {
	it("keeps only durable types, drops progress/action/question/error", () => {
		const acts = [
			activity({ type: "progress" }),
			activity({ type: "action" }),
			activity({ type: "question" }),
			activity({ type: "error" }),
			activity({ type: "response" }),
			activity({ type: "finding" }),
			activity({ type: "verification" }),
			activity({ type: "decision" }),
			activity({ type: "handoff" }),
		];
		const durable = Planner.selectDurableActivities(acts);
		expect(durable.map((a) => a.type).sort()).toEqual([
			"decision",
			"finding",
			"handoff",
			"response",
			"verification",
		]);
	});

	it("keeps only the latest ephemeral (chronological input)", () => {
		const acts = [
			activity({ type: "finding", ephemeral: true }),
			activity({ type: "finding", ephemeral: true }),
			activity({ type: "finding", ephemeral: true }),
		];
		const durable = Planner.selectDurableActivities(acts);
		// Only the last ephemeral finding survives.
		expect(durable).toHaveLength(1);
		expect(durable[0]?.id).toBe(acts[2]?.id);
	});

	it("preserves input (chronological) order", () => {
		const a = activity({ type: "finding" });
		const b = activity({ type: "decision" });
		const c = activity({ type: "response" });
		const durable = Planner.selectDurableActivities([a, b, c]);
		expect(durable.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
	});

	it("returns [] for an empty or all-noise trail", () => {
		expect(Planner.selectDurableActivities([])).toEqual([]);
		expect(
			Planner.selectDurableActivities([
				activity({ type: "progress" }),
				activity({ type: "action" }),
			]),
		).toEqual([]);
	});
});

describe("Planner.toSessionCard", () => {
	it("finalResponse = latest response excerpt (~200 chars) with ellipsis", () => {
		const long = "x".repeat(500);
		const card = Planner.toSessionCard(session(), [
			activity({ type: "decision", body: "earlier decision" }),
			activity({ type: "response", body: long }),
		]);
		expect(card.finalResponse?.endsWith("…")).toBe(true);
		expect(card.finalResponse?.length).toBe(201); // 200 chars + ellipsis
	});

	it("finalResponse falls back to latest durable when no response", () => {
		const card = Planner.toSessionCard(session(), [
			activity({ type: "finding", body: "a finding" }),
			activity({ type: "decision", body: "the decision" }),
		]);
		expect(card.finalResponse).toBe("the decision");
	});

	it("prefers a response over a later non-response durable", () => {
		const card = Planner.toSessionCard(session(), [
			activity({ type: "response", body: "the response" }),
			activity({ type: "decision", body: "later decision" }),
		]);
		expect(card.finalResponse).toBe("the response");
	});

	it("never yields a blank finalResponse — skips blank bodies", () => {
		const card = Planner.toSessionCard(session(), [
			activity({ type: "decision", body: "real content" }),
			activity({ type: "response", body: "   " }),
		]);
		// Latest response is blank → falls back to the non-blank durable.
		expect(card.finalResponse).toBe("real content");
	});

	it("finalResponse undefined only when there is zero durable activity", () => {
		const card = Planner.toSessionCard(session(), [
			activity({ type: "progress", body: "spinner" }),
			activity({ type: "question", body: "a question?" }),
		]);
		expect(card.finalResponse).toBeUndefined();
		expect(card.activityCount).toBe(0);
	});

	it("counts severity across BOTH finding and verification (durable)", () => {
		const card = Planner.toSessionCard(session(), [
			activity({ type: "progress" }), // noise, excluded
			activity({ type: "finding", severity: "P1" }),
			activity({ type: "verification", severity: "P1" }), // S4b, also counted
			activity({ type: "finding", severity: "P2" }),
			activity({ type: "verification", severity: "P3" }),
			activity({ type: "decision", body: "d" }),
		]);
		expect(card.activityCount).toBe(5); // 2 findings + 2 verifications + 1 decision
		expect(card.findingCounts).toEqual({ P1: 2, P2: 1, P3: 1 });
	});

	it("hasQuestion is state-based — true iff session is awaiting_input", () => {
		// Asked-then-answered: state is complete → NOT awaiting input.
		const answered = Planner.toSessionCard(session({ state: "complete" }), [
			activity({ type: "question", body: "?" }),
			activity({ type: "response", body: "answered" }),
		]);
		expect(answered.hasQuestion).toBe(false);

		// Currently blocked on a human answer.
		const waiting = Planner.toSessionCard(
			session({ state: "awaiting_input" }),
			[activity({ type: "question", body: "?" })],
		);
		expect(waiting.hasQuestion).toBe(true);
	});

	it("carries session identity + timestamps through", () => {
		const s = session({
			id: "sess-9",
			agent: "wave-2",
			state: "awaiting_input",
			startedAt: "2026-07-16T01:00:00.000Z",
			lastActivityAt: "2026-07-16T02:00:00.000Z",
			endedAt: "2026-07-16T03:00:00.000Z",
		});
		const card = Planner.toSessionCard(s, [
			activity({ type: "response", body: "r" }),
		]);
		expect(card.id).toBe("sess-9");
		expect(card.agent).toBe("wave-2");
		expect(card.state).toBe("awaiting_input");
		expect(card.startedAt).toBe("2026-07-16T01:00:00.000Z");
		expect(card.lastActivityAt).toBe("2026-07-16T02:00:00.000Z");
		expect(card.endedAt).toBe("2026-07-16T03:00:00.000Z");
	});
});
