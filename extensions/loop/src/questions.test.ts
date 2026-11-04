import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answersContext, Planner } from "@cabane/core";
import { Questions } from "./questions";

let base = "";
let sessionId = "";

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-questions-"));
	await Planner.init(base);
	const task = await Planner.addTask(base, { kind: "issue", title: "sub" });
	if (!task.ok) throw task.error;
	const started = await Planner.startSession(base, {
		taskId: task.value.id,
		agent: "claude",
	});
	if (!started.ok) throw started.error;
	sessionId = started.value.id;
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const deps = () => ({ basePath: base, sessionId, emit: () => {}, pollMs: 5 });

const ask = async (body: string): Promise<string> => {
	const asked = await Planner.addActivity(base, {
		sessionId,
		type: "question",
		body,
	});
	if (!asked.ok) throw asked.error;
	return asked.value.id;
};

// Never aborts: a wait that does not stop on its own runs into the test's timeout.
const forever = new AbortController().signal;

describe("Questions.awaitAnswers", () => {
	it("stops waiting on a question closed as withdrawn, never taking the withdrawal as its answer", async () => {
		const questionId = await ask("Which port?");
		await Questions.withdraw(deps(), [questionId], "withdrawn: nobody is left");
		const waited = await Questions.awaitAnswers(deps(), [questionId], forever);
		expect(waited).toBeUndefined();
	});

	it("takes the human's answer over a withdrawal, and returns the answers it has before it stops", async () => {
		const answered = await ask("Which store?");
		const withdrawn = await ask("Which port?");
		const human = await Planner.answerQuestion(base, {
			questionId: answered,
			answer: "Redis",
		});
		if (!human.ok) throw human.error;
		const closed = await Planner.addActivity(base, {
			sessionId,
			type: "withdrawn",
			context: answersContext(withdrawn),
			body: "withdrawn: nobody is left",
		});
		if (!closed.ok) throw closed.error;
		const waited = await Questions.awaitAnswers(
			deps(),
			[answered, withdrawn],
			forever,
		);
		expect(waited && [...waited].map(([id, a]) => [id, a.body])).toEqual([
			[answered, "Redis"],
		]);
		const after = await Questions.awaitAnswers(deps(), [withdrawn], forever);
		expect(after).toBeUndefined();
	});
});
