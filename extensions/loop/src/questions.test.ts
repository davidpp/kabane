import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import "@kabane/core/testing";
import { join } from "node:path";
import { Planner } from "@kabane/core";
import { Loop } from "./commands";
import { Elicitation } from "./elicitation";
import { Permission } from "./permission";
import { answersContext } from "./question-body";
import { Questions } from "./questions";
import { RunStore } from "./store";
import { testHost } from "./test-host";
import { TestSessions } from "./test-sessions";

let base = "";
let sessionId = "";

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-questions-"));
	await Planner.init(base);
	const task = await Planner.addTask(base, { kind: "issue", title: "sub" });
	if (!task.ok) throw task.error;
	const started = await TestSessions.open(base, {
		taskId: task.value.id,
		agent: "claude",
	});
	if (!started.ok) throw started.error;
	sessionId = started.value.id;
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const deps = () => ({
	home: base,
	runId: "test-run",
	record: testHost(base).record,
	sessionId,
	emit: () => {},
	pollMs: 5,
});

const ask = async (body: string): Promise<string> => {
	const asked = await TestSessions.append(base, {
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
		const human = await TestSessions.submit(base, {
			questionId: answered,
			answer: "Redis",
		});
		if (!human.ok) throw human.error;
		const closed = await TestSessions.append(base, {
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

it("records only human non-permission decisions in the real task timeline, accepting duplicate submissions once", async () => {
	const id = await ask("Which store?");
	const run = TestSessions.owner(base, sessionId);
	for (const answer of ["SQLite", "Files"])
		expect(
			RunStore.appendInbox(base, run.id, {
				kind: "answered",
				questionId: id,
				answer,
				by: "kabane://actor/human/david",
				at: new Date().toISOString(),
			}).ok,
		).toBe(true);
	const waited = await Questions.awaitAnswers(deps(), [id], forever);
	expect(waited?.get(id)?.body).toBe("SQLite");
	expect(waited?.get(id)?.by).toBe("kabane://actor/human/david");
	const permission = await ask(
		Permission.body("claude", {
			toolCallId: "call",
			title: "Write notes.md",
			options: [{ id: "allow", name: "Allow", kind: "allow_once" }],
		}),
	);
	expect(
		(
			await TestSessions.submit(base, {
				questionId: permission,
				answer: "Allow",
			})
		).ok,
	).toBe(true);
	expect(
		(await Questions.awaitAnswers(deps(), [permission], forever))?.get(
			permission,
		)?.type,
	).toBe("answer");
	const comments = await Planner.getEntries(base, run.parentId);
	expect(comments.ok && comments.value.map((c) => [c.kind, c.content])).toEqual(
		[
			[
				"outcome.decision",
				"Which store?\n→ SQLite (chosen by kabane://actor/human/david)",
			],
		],
	);
	const entries = RunStore.questionEntries(base, run.id);
	expect(
		entries.ok && entries.value.filter((e) => e.context === `answers ${id}`),
	).toHaveLength(1);
});

it("records an optional form field's skip as an answer without a timeline decision", async () => {
	const request = {
		message: "Optional details",
		fields: [
			{ key: "note", title: "Note", type: "text" as const, required: false },
		],
	};
	const [field] = Elicitation.questions(request.fields);
	if (!field) throw new Error("no field");
	const id = await ask(
		Elicitation.body("claude", request, field, { index: 0, total: 1 }),
	);
	const answered = await Loop.answer(
		{
			home: base,
			basePath: base,
			host: testHost(base),
			actor: "kabane://actor/human/david",
		},
		id,
		"SKIP",
	);
	if (!answered.ok) throw answered.error;
	const waited = await Questions.awaitAnswers(deps(), [id], forever);
	expect(waited?.get(id)?.type).toBe("answer");
	const journal = TestSessions.journal(base, sessionId);
	expect(
		journal.ok &&
			journal.value
				.filter((e) => e.context === answersContext(id))
				.map((e) => e.type),
	).toEqual(["answer"]);
	const run = TestSessions.owner(base, sessionId);
	const comments = await Planner.getEntries(base, run.parentId);
	expect(comments.ok && comments.value).toEqual([]);
});
