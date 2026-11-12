import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Oplog, Planner, type Result, withDb } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { questionsModule } from "./module";
import { questionPage } from "./page";
import { Questions } from "./storage";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-questions-"));
	configureTestRuntime({
		modules: [questionsModule],
		actor: () => "cabane://actor/human/test",
	});
	unwrap(await Planner.init(base));
	unwrap(await withDb(base, (db) => Oplog.initDevice(db, "questions-test")));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const issue = async (title = "Decision", scopeUri = "questions") =>
	unwrap(await Planner.addTask(base, { title, kind: "issue", scopeUri }));
const ask = async (id: string) =>
	unwrap(
		await Questions.ask(base, {
			id,
			questions: [
				{
					question: "Which store?",
					choices: ["SQLite", "Remote"],
					recommended: "SQLite",
					allowFreeform: false,
					why: "Local first\nwithout a network",
				},
				{ question: "Which name?" },
			],
		}),
	);

it("migrates prefixed tables, assigns stable ordinals and captures every write", async () => {
	const task = await issue();
	const rows = await ask(task.shortId ?? task.id);
	expect(rows.map((row) => row.handle)).toEqual([
		`${task.shortId}:1`,
		`${task.shortId}:2`,
	]);
	const first = rows[0];
	if (!first) throw new Error("Missing first question");
	unwrap(
		await Questions.answer(base, {
			question: first.handle,
			answer: "sqlite",
			reasoning: "Offline",
		}),
	);
	const reanswer = unwrap(
		await Questions.answer(base, { question: first.id, answer: "Remote" }),
	);
	expect(reanswer.question).toMatchObject({
		answer: "Remote",
		version: 3,
		answeredBy: "cabane://actor/human/test",
	});
	expect(
		unwrap(await Questions.list(base, { id: task.id, status: "open" })).map(
			(row) => row.handle,
		),
	).toEqual([`${task.shortId}:2`]);
	const ops = unwrap(
		await withDb(base, (db) =>
			db
				.query<{ module: string; module_schema: number }>(
					"SELECT module, module_schema FROM sync_oplog WHERE tbl = 'task_questions'",
				)
				.all(),
		),
	);
	expect(ops).toHaveLength(4);
	expect(
		ops.every((op) => op.module === "questions" && op.module_schema === 1),
	).toBe(true);
});

it("refuses invalid batches and answers without partial writes", async () => {
	const task = await issue();
	expect(
		(
			await Questions.ask(base, {
				id: task.id,
				questions: [
					{ question: "Fine" },
					{ question: "Invalid", choices: ["A"], recommended: "B" },
				],
			})
		).ok,
	).toBe(false);
	expect(unwrap(await Questions.list(base, { id: task.id }))).toHaveLength(0);
	const rows = await ask(task.id);
	const first = rows[0];
	if (!first) throw new Error("Missing question");
	expect(
		(
			await Questions.answer(base, {
				question: first.handle,
				answer: "Invalid",
			})
		).ok,
	).toBe(false);
	expect(
		(await Questions.answer(base, { question: first.handle, withdraw: true }))
			.ok,
	).toBe(false);
	expect(unwrap(await Questions.list(base, { id: task.id }))[0]?.version).toBe(
		1,
	);
	const taskOnly = unwrap(await Planner.addTask(base, { title: "Human task" }));
	expect(
		(
			await Questions.ask(base, {
				id: taskOnly.id,
				questions: [{ question: "No" }],
			})
		).ok,
	).toBe(false);
});

it("renders selected brief decisions and omits withdrawals", async () => {
	const task = await issue();
	const rows = await ask(task.id);
	const first = rows[0];
	const second = rows[1];
	if (!first || !second) throw new Error("Missing questions");
	const open = unwrap(
		await Planner.getContextPage(base, task.id, {
			sections: ["questions.decisions"],
		}),
	);
	expect(open.markdown).toContain("- SQLite ★");
	expect(open.markdown).toContain("why: Local first without a network");
	unwrap(
		await Questions.answer(base, {
			question: first.id,
			answer: "SQLite",
			reasoning: "Local",
		}),
	);
	unwrap(
		await Questions.answer(base, {
			question: second.id,
			withdraw: true,
			reasoning: "No longer needed",
		}),
	);
	const brief = unwrap(await Planner.assembleContext(base, task.id));
	expect(brief).toContain(
		"Which store? (choices only) → SQLite (cabane://actor/human/test, Local)",
	);
	expect(brief).not.toContain("Which name?");
});

it("paginates selected questions and invalidates stale or mismatched cursors", async () => {
	const task = await issue();
	await ask(task.id);
	const page = unwrap(await questionPage(base, { id: task.shortId, limit: 1 }));
	const cursor = page.split("nextCursor: ")[1];
	expect(cursor).toBeDefined();
	const next = unwrap(
		await questionPage(base, { id: task.id, limit: 1, cursor }),
	);
	expect(next).toContain(`${task.shortId}:2`);
	expect(next).not.toContain("nextCursor:");
	expect(
		(await questionPage(base, { id: task.id, cursor, status: "all" })).ok,
	).toBe(false);
	await issue("Unrelated", "elsewhere");
	expect((await questionPage(base, { id: task.id, cursor })).ok).toBe(true);
	unwrap(await Planner.updateTask(base, task.id, { title: "Renamed" }));
	expect((await questionPage(base, { id: task.id, cursor })).ok).toBe(false);
	expect((await questionPage(base, { cursor: "invalid" })).ok).toBe(false);
});

it("inherits private visibility and never captures private questions", async () => {
	const task = await issue();
	unwrap(
		await withDb(base, (db) =>
			db.run("UPDATE tasks SET visibility = 'private' WHERE id = ?", [task.id]),
		),
	);
	const rows = await ask(task.id);
	const first = rows[0];
	if (!first) throw new Error("Missing question");
	unwrap(
		await Questions.answer(base, { question: first.id, answer: "SQLite" }),
	);
	expect(first.visibility).toBe("private");
	const ops = unwrap(
		await withDb(base, (db) =>
			db.query("SELECT * FROM sync_oplog WHERE tbl = 'task_questions'").all(),
		),
	);
	expect(ops).toHaveLength(0);
});

it("bounds default pages and keeps ordinals across answered and withdrawn rows", async () => {
	const task = await issue();
	for (let batch = 0; batch < 3; batch++) {
		unwrap(
			await Questions.ask(base, {
				id: task.id,
				waiting: false,
				questions: Array.from({ length: 10 }, (_, i) => ({
					question: `Decision ${batch * 10 + i + 1}`,
				})),
			}),
		);
	}
	const page = unwrap(await questionPage(base, { id: task.id }));
	expect(page).toContain(`${task.shortId}:20 `);
	expect(page).not.toContain(`${task.shortId}:21 `);
	const cursor = page.split("nextCursor: ")[1];
	expect(cursor).toBeDefined();
	expect(unwrap(await questionPage(base, { id: task.id, cursor }))).toContain(
		`${task.shortId}:30 `,
	);
	unwrap(
		await Questions.answer(base, {
			question: `${task.shortId}:1`,
			answer: "Done",
		}),
	);
	unwrap(
		await Questions.answer(base, {
			question: `${task.shortId}:2`,
			withdraw: true,
			reasoning: "Obsolete",
		}),
	);
	const open = unwrap(await questionPage(base, { id: task.id, limit: 1 }));
	expect(open).toContain(`${task.shortId}:3 `);
	expect(open).not.toContain(`${task.shortId}:1 `);
});

it("waits by default, resumes only on the last open answer and leaves re-answers alone", async () => {
	const task = await issue();
	await ask(task.id);
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `${task.shortId}:1`,
				answer: "SQLite",
			}),
		).moved,
	).toBe(false);
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `${task.shortId}:2`,
				answer: "Kabane",
			}),
		).moved,
	).toBe(true);
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("next");
	unwrap(await Planner.updateTask(base, task.id, { state: "waiting" }));
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `${task.shortId}:2`,
				answer: "Another name",
			}),
		).moved,
	).toBe(false);
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
});

it("withdrawal closes the last question, while waiting:false and non-waiting issues are left alone", async () => {
	const task = await issue();
	await ask(task.id);
	unwrap(
		await Questions.answer(base, {
			question: `${task.shortId}:1`,
			answer: "SQLite",
		}),
	);
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `${task.shortId}:2`,
				withdraw: true,
				reasoning: "Obsolete",
			}),
		).moved,
	).toBe(true);
	const other = await issue("Keep working");
	unwrap(await Planner.updateTask(base, other.id, { state: "in_progress" }));
	unwrap(
		await Questions.ask(base, {
			id: other.id,
			waiting: false,
			questions: [{ question: "Optional" }],
		}),
	);
	expect(unwrap(await Planner.getTask(base, other.id))?.state).toBe(
		"in_progress",
	);
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `${other.shortId}:1`,
				answer: "Yes",
			}),
		).moved,
	).toBe(false);
	expect(unwrap(await Planner.getTask(base, other.id))?.state).toBe(
		"in_progress",
	);
});

it("rolls back the answer and oplog if the task move fails, and notifies only after commit", async () => {
	const seen: string[] = [];
	configureTestRuntime({
		modules: [questionsModule],
		notifier: async (type) => {
			if (type !== "planner.task.updated") return;
			// A separate connection must already see the committed question and task.
			const tasks = unwrap(await Planner.queryTasks(base, {}));
			const rows = unwrap(await Questions.list(base));
			seen.push(`${tasks[0]?.state}:${rows[0]?.status}`);
		},
	});
	const task = await issue();
	unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [{ question: "Proceed?" }],
		}),
	);
	expect(seen).toEqual(["waiting:open"]);
	unwrap(
		await withDb(base, (db) =>
			db.run(
				"CREATE TRIGGER refuse_resume BEFORE UPDATE OF state ON tasks WHEN NEW.state = 'next' BEGIN SELECT RAISE(ABORT, 'resume refused'); END",
			),
		),
	);
	const count = async () =>
		unwrap(
			await withDb(base, (db) =>
				db.query<{ n: number }>("SELECT COUNT(*) n FROM sync_oplog").get(),
			),
		)?.n;
	const before = await count();
	const failed = await Questions.answer(base, {
		question: `${task.shortId}:1`,
		answer: "Yes",
	});
	expect(failed.ok).toBe(false);
	if (!failed.ok) expect(failed.error.message).toContain("resume refused");
	expect(unwrap(await Questions.list(base))[0]).toMatchObject({
		status: "open",
		answer: undefined,
		version: 1,
	});
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
	expect(await count()).toBe(before);
	expect(seen).toEqual(["waiting:open"]);
	unwrap(await withDb(base, (db) => db.run("DROP TRIGGER refuse_resume")));
	unwrap(
		await Questions.answer(base, {
			question: `${task.shortId}:1`,
			answer: "Yes",
		}),
	);
	expect(seen).toEqual(["waiting:open", "next:answered"]);
});

it("matches base and qualified scope filters against the same family as kabane_list", async () => {
	const bare = await issue("Base", "family");
	const qualified = await issue("Branch", "jake://scope/family?branch=review");
	const outside = await issue("Outside", "family-other");
	for (const task of [bare, qualified, outside]) await ask(task.id);
	for (const scopeUri of ["family", "jake://scope/family?branch=review"]) {
		const tasks = unwrap(await Planner.queryTasks(base, { scopeUri }));
		const rows = unwrap(await Questions.list(base, { scopeUri }));
		expect([...new Set(rows.map((row) => row.taskId))].sort()).toEqual(
			tasks.map((task) => task.id).sort(),
		);
		expect(rows).toHaveLength(4);
		const page = unwrap(await questionPage(base, { scopeUri }));
		expect(page).toContain("Base");
		expect(page).toContain("Branch");
		expect(page).not.toContain("Outside");
	}
});

it("does not rewrite a waiting issue and refuses closed issues until reopened", async () => {
	const task = await issue();
	unwrap(await Planner.updateTask(base, task.id, { state: "waiting" }));
	const before = unwrap(await Planner.getTask(base, task.id));
	await ask(task.id);
	expect(unwrap(await Planner.getTask(base, task.id))).toEqual(before);
	for (const state of ["done", "cancelled"] as const) {
		const closed = await issue(state);
		unwrap(await Planner.updateTask(base, closed.id, { state }));
		for (const waiting of [true, false]) {
			const refused = await Questions.ask(base, {
				id: closed.id,
				waiting,
				questions: [{ question: "Reopen?" }],
			});
			expect(refused.ok).toBe(false);
			if (!refused.ok)
				expect(refused.error.message).toContain("reopen it first");
		}
		expect(unwrap(await Questions.list(base, { id: closed.id }))).toHaveLength(
			0,
		);
		expect(unwrap(await Planner.getTask(base, closed.id))?.state).toBe(state);
		unwrap(await Planner.updateTask(base, closed.id, { state: "next" }));
		expect(
			(
				await Questions.ask(base, {
					id: closed.id,
					questions: [{ question: "Now?" }],
				})
			).ok,
		).toBe(true);
	}
});

it("stores canonical recommendations and refuses mistyped choices by default", async () => {
	const task = await issue();
	const rows = unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [
				{ question: "Pick", choices: ["Alpha", "Beta"], recommended: "aLPHa" },
			],
		}),
	);
	const row = rows[0];
	if (!row) throw new Error("Missing question");
	expect(row.body).toContain('"recommended":"Alpha"');
	expect(row.body).toContain('"allowFreeform":false');
	expect(
		(await Questions.answer(base, { question: row.id, answer: "Alhpa" })).ok,
	).toBe(false);
	expect(
		(await Questions.answer(base, { question: row.id, answer: "alpha" })).ok,
	).toBe(true);
});

it("answers by id:<ULID>, the form a page prints at the end of each question's line", async () => {
	const task = await issue();
	const [first] = await ask(task.id);
	if (!first) throw new Error("Missing question");
	expect(
		unwrap(
			await Questions.answer(base, {
				question: `id:${first.id}`,
				answer: "remote",
			}),
		).question,
	).toMatchObject({ id: first.id, answer: "Remote" });
	expect(
		(
			await Questions.answer(base, {
				question: "id:01M0000000000000000000000Z",
				answer: "x",
			})
		).ok,
	).toBe(false);
});

it("replaces an open question in one write: withdrawn as replaced, the issue still waiting", async () => {
	const task = await issue();
	const [first] = unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [
				{
					question: "Which scope source?",
					choices: ["A. The pin", "B. The remote", "C. The directory"],
				},
			],
		}),
	);
	if (!first) throw new Error("Missing question");
	const [second] = unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [
				{
					question: "Which scope sources, in order?",
					choices: [
						"A. The pin",
						"B. The remote, normalized",
						"C. The directory",
					],
					multiSelect: true,
					replaces: `id:${first.id}`,
				},
			],
		}),
	);
	if (!second) throw new Error("Missing replacement");
	expect(second.handle).toBe(`${task.shortId}:2`);
	expect(unwrap(await Questions.list(base, { id: task.id }))[0]).toMatchObject({
		status: "withdrawn",
		reasoning: `${Questions.REPLACED_REASON} ${second.handle} id:${second.id}`,
		answeredBy: "cabane://actor/human/test",
	});
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
	const answered = unwrap(
		await Questions.answer(base, {
			question: `id:${second.id}`,
			answer: "b, c",
		}),
	);
	expect(answered).toMatchObject({
		question: { answer: "B. The remote, normalized, C. The directory" },
		moved: true,
	});
});

it("refuses a replacement of a question it cannot supersede, writing nothing", async () => {
	const task = await issue();
	const other = await issue("Other");
	const [open, closed] = await ask(task.id);
	const [elsewhere] = await ask(other.id);
	if (!open || !closed || !elsewhere) throw new Error("Missing questions");
	unwrap(
		await Questions.answer(base, { question: closed.id, answer: "Kabane" }),
	);
	for (const [replaces, message] of [
		[
			closed.handle,
			`${closed.handle} is answered; only an open question can be replaced.`,
		],
		[
			elsewhere.handle,
			`${elsewhere.handle} is on another issue; ask its replacement on that issue.`,
		],
		[`${task.shortId}:9`, `No question found: ${task.shortId}:9`],
		[
			"id:01M0000000000000000000000Z",
			"No question found: id:01M0000000000000000000000Z",
		],
	] as const) {
		const refused = await Questions.ask(base, {
			id: task.id,
			questions: [{ question: "Reshaped?", replaces }],
		});
		expect(refused.ok ? "" : refused.error.message).toBe(message);
	}
	const twice = await Questions.ask(base, {
		id: task.id,
		questions: [
			{ question: "One?", replaces: open.handle },
			{ question: "Two?", replaces: open.id },
		],
	});
	expect(twice.ok ? "" : twice.error.message).toBe(
		`${open.id} is replaced twice in one call.`,
	);
	expect(
		unwrap(await Questions.list(base, { id: task.id })).map(
			(row) => row.status,
		),
	).toEqual(["open", "answered"]);
});

const questionOps = async () =>
	unwrap(
		await withDb(base, (db) =>
			db
				.query<{ n: number }>(
					"SELECT COUNT(*) n FROM sync_oplog WHERE tbl = 'task_questions'",
				)
				.get(),
		),
	)?.n;

it("closing an issue withdraws its open questions as issue closed, keeps answers, and reopening restores none", async () => {
	for (const state of ["done", "cancelled"] as const) {
		const task = await issue(state);
		await ask(task.id);
		unwrap(
			await Questions.answer(base, {
				question: `${task.shortId}:1`,
				answer: "SQLite",
			}),
		);
		const before = await questionOps();
		unwrap(await Planner.updateTask(base, task.id, { state }));
		const closed = unwrap(await Questions.list(base, { id: task.id }));
		expect(
			closed.map((row) => [row.status, row.answer, row.reasoning]),
		).toEqual([
			["answered", "SQLite", undefined],
			["withdrawn", undefined, Questions.CLOSED_REASON],
		]);
		expect(closed[1]).toMatchObject({
			answeredBy: "cabane://actor/human/test",
			version: 2,
		});
		expect(await questionOps()).toBe((before ?? 0) + 1);

		unwrap(await Planner.updateTask(base, task.id, { state: "next" }));
		expect(
			unwrap(await Questions.list(base, { id: task.id, status: "open" })),
		).toEqual([]);
		expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("next");
	}
});

it("rolls the close back when withdrawing its questions fails", async () => {
	const task = await issue();
	await ask(task.id);
	unwrap(
		await withDb(base, (db) =>
			db.run(
				"CREATE TRIGGER refuse_withdraw BEFORE UPDATE OF status ON task_questions WHEN NEW.status = 'withdrawn' BEGIN SELECT RAISE(ABORT, 'withdraw refused'); END",
			),
		),
	);
	const count = async () =>
		unwrap(
			await withDb(base, (db) =>
				db.query<{ n: number }>("SELECT COUNT(*) n FROM sync_oplog").get(),
			),
		)?.n;
	const before = await count();
	const closed = await Planner.updateTask(base, task.id, { state: "done" });
	expect(closed.ok).toBe(false);
	if (!closed.ok) expect(closed.error.message).toContain("withdraw refused");
	expect(unwrap(await Planner.getTask(base, task.id))?.state).toBe("waiting");
	expect(
		unwrap(await Questions.list(base, { id: task.id, status: "open" })),
	).toHaveLength(2);
	expect(await count()).toBe(before);
});

it("notifies a close only after its withdrawals commit", async () => {
	const seen: string[] = [];
	configureTestRuntime({
		modules: [questionsModule],
		notifier: async (type, payload) => {
			if (type !== "planner.task.updated") return;
			const id = (payload as { id: string }).id;
			// A separate connection must already see the closed task and its withdrawal.
			const task = unwrap(await Planner.getTask(base, id));
			const rows = unwrap(await Questions.list(base, { id }));
			seen.push(`${task?.state}:${rows.map((row) => row.status).join(",")}`);
		},
	});
	const task = await issue();
	await ask(task.id);
	seen.length = 0;
	unwrap(await Planner.updateTask(base, task.id, { state: "done" }));
	expect(seen).toEqual(["done:withdrawn,withdrawn"]);
});
