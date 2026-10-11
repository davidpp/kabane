import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpClient } from "@cabane/acp";
import { parseQuestionBody, Planner, type Result } from "@cabane/core";
import { Permission } from "./permission";
import type { RunStore } from "./store";

let base = "";

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-permission-"));
	await Planner.init(base);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

// The options claude-agent-acp offers for a file write, as it sends them.
const REQUEST: AcpClient.PermissionRequest = {
	toolCallId: "toolu_01",
	title: "Write notes.md",
	options: [
		{ id: "allow_always", name: "Always Allow", kind: "allow_always" },
		{ id: "allow", name: "Allow", kind: "allow_once" },
		{ id: "reject", name: "Reject", kind: "reject_once" },
	],
};

const session = async (): Promise<string> => {
	const task = await Planner.addTask(base, { kind: "issue", title: "sub" });
	if (!task.ok) throw task.error;
	const started = await Planner.startSession(base, {
		taskId: task.value.id,
		agent: "claude",
	});
	if (!started.ok) throw started.error;
	return started.value.id;
};

type Relayed = {
	result: Promise<Result<string>>;
	events: Omit<RunStore.EventDraft, "lane" | "session" | "task">[];
	controller: AbortController;
};

const relay = (sessionId: string, by?: string): Relayed => {
	const events: Relayed["events"] = [];
	const controller = new AbortController();
	const result = Permission.relay(
		{
			basePath: base,
			sessionId,
			harness: "claude",
			origin: "test",
			signal: controller.signal,
			emit: (e) => events.push(e),
			answeredBy: () => by,
			now: () => new Date(),
			pollMs: 5,
		},
		REQUEST,
	);
	return { result, events, controller };
};

// The question the relay put on the session, once it is there.
const pending = async (sessionId: string) => {
	for (let i = 0; i < 200; i++) {
		const needs = await Planner.getNeedsInput(base);
		if (!needs.ok) throw needs.error;
		const row = needs.value.find((r) => r.session.id === sessionId);
		if (row?.question) return row.question;
		await Bun.sleep(5);
	}
	throw new Error("no question appeared");
};

const answer = async (questionId: string, text: string) => {
	const answered = await Planner.answerQuestion(base, {
		questionId,
		answer: text,
	});
	if (!answered.ok) throw answered.error;
};

describe("Permission.body", () => {
	it("carries the harness's options verbatim and the tool call's title", () => {
		const parsed = parseQuestionBody(Permission.body("claude", REQUEST));
		expect(parsed.question).toBe("claude asks to run: Write notes.md");
		expect(parsed.choices).toEqual(["Always Allow", "Allow", "Reject"]);
		expect(parsed.allowFreeform).toBe(false);
		expect(parsed.permission).toEqual({
			toolCallId: "toolu_01",
			title: "Write notes.md",
			options: [
				{ id: "allow_always", label: "Always Allow", kind: "allow_always" },
				{ id: "allow", label: "Allow", kind: "allow_once" },
				{ id: "reject", label: "Reject", kind: "reject_once" },
			],
		});
	});
});

describe("Permission.choose", () => {
	const options = [
		{ id: "allow_always", label: "Always Allow", kind: "allow_always" },
		{ id: "allow", label: "Allow", kind: "allow_once" },
		{ id: "reject", label: "Reject", kind: "reject_once" },
	];

	it("maps an id, a label in any case, or a 1-based position to the option", () => {
		expect(Permission.choose(options, "reject")?.id).toBe("reject");
		expect(Permission.choose(options, "always allow")?.id).toBe("allow_always");
		expect(Permission.choose(options, " Allow ")?.id).toBe("allow");
		expect(Permission.choose(options, "2")?.id).toBe("allow");
	});

	it("names nothing for an answer that is not an option", () => {
		expect(Permission.choose(options, "yes")).toBeUndefined();
		expect(Permission.choose(options, "0")).toBeUndefined();
		expect(Permission.choose(options, "4")).toBeUndefined();
	});
});

describe("Permission.relay", () => {
	it("waits on the human, then answers the harness with the option they chose", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId, "cabane://actor/human/david");
		const question = await pending(sessionId);
		const waiting = await Planner.getSession(base, sessionId);
		expect(waiting.ok && waiting.value?.state).toBe("awaiting_input");
		expect(parseQuestionBody(question.body).permission?.title).toBe(
			"Write notes.md",
		);

		await answer(question.id, "Allow");
		const chosen = await result;
		expect(chosen.ok && chosen.value).toBe("allow");
		const answered = events.find((e) => e.type === "permission_answered");
		expect(answered?.data).toMatchObject({
			questionId: question.id,
			optionId: "allow",
			optionKind: "allow_once",
			by: "cabane://actor/human/david",
		});
		const after = await Planner.getNeedsInput(base);
		expect(after.ok && after.value).toEqual([]);
	});

	it("asks again when the answer names no option, rather than guessing", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId);
		const first = await pending(sessionId);
		await answer(first.id, "sure, go ahead");
		const second = await pending(sessionId);
		expect(second.id).not.toBe(first.id);
		await answer(second.id, "3");
		const chosen = await result;
		expect(chosen.ok && chosen.value).toBe("reject");
		expect(
			events
				.filter((e) => e.type === "permission_asked")
				.map((e) => e.data?.questionId),
		).toEqual([first.id, second.id]);
		expect(events.find((e) => e.type === "permission_answered")?.data?.by).toBe(
			"unrecorded",
		);
	});

	it("on stop, cancels the request unanswered, and the ended session no longer needs input", async () => {
		const sessionId = await session();
		const { result, events, controller } = relay(sessionId);
		const question = await pending(sessionId);

		controller.abort();
		const outcome = await result;
		expect(outcome.ok).toBe(false);
		expect(events.map((e) => e.type)).toEqual([
			"permission_asked",
			"permission_cancelled",
		]);
		const activities = await Planner.getActivities(base, sessionId);
		expect(
			activities.ok && activities.value.some((a) => a.type === "decision"),
		).toBe(false);

		// What the runner's settle does with a cancelled claim.
		const ended = await Planner.endSession(base, sessionId, { state: "error" });
		expect(ended.ok).toBe(true);
		const needs = await Planner.getNeedsInput(base);
		expect(
			needs.ok && needs.value.some((r) => r.question?.id === question.id),
		).toBe(false);
	});
});
