import "../testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft } from "../schemas";
import { answersContext } from "../schemas";
import { Planner } from "./index";
import { SESSION_STALE_MS } from "./sessions";

const TEST_BASE = join(import.meta.dir, ".test-data-sessions");

const draft: TaskDraft = { title: "Agent work", kind: "issue" };

/** Create an issue and return its id. */
const createTask = async (): Promise<string> => {
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error("failed to create task");
	return result.value.id;
};

/** Start a session on a fresh task and return {taskId, sessionId}. */
const startOn = async (
	agent = "claude",
): Promise<{ taskId: string; sessionId: string }> => {
	const taskId = await createTask();
	const started = await Planner.startSession(TEST_BASE, { taskId, agent });
	if (!started.ok) throw new Error("failed to start session");
	return { taskId, sessionId: started.value.id };
};

/** Count rows in the raw agent_activities table (for compaction assertions). */
const countActivities = (sessionId: string): number => {
	const db = new Database(join(TEST_BASE, "cabane.db"));
	try {
		const row = db
			.query("SELECT COUNT(*) AS n FROM agent_activities WHERE session_id = ?")
			.get(sessionId) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
};

describe("Planner — Agent Sessions", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("starts a session defaulting to active", async () => {
		const taskId = await createTask();
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
			externalRef: "loop:wave-1",
		});
		expect(started.ok).toBe(true);
		if (started.ok) {
			expect(started.value.state).toBe("active");
			expect(started.value.agent).toBe("claude");
			expect(started.value.externalRef).toBe("loop:wave-1");
			expect(started.value.endedAt).toBeUndefined();
			expect(started.value.startedAt).toBe(started.value.lastActivityAt);
		}
	});

	it("can start pending (pre-dispatch batch)", async () => {
		const taskId = await createTask();
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
			state: "pending",
		});
		expect(started.ok && started.value.state).toBe("pending");
	});

	it("runs a full lifecycle: start → activities → end complete", async () => {
		const { sessionId } = await startOn();

		const a1 = await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "action",
			body: "ran the build",
		});
		expect(a1.ok).toBe(true);

		const a2 = await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "finding",
			severity: "P2",
			category: "perf",
			body: "slow query",
		});
		expect(a2.ok).toBe(true);

		const ended = await Planner.endSession(TEST_BASE, sessionId, {
			state: "complete",
			summary: "done",
		});
		expect(ended.ok).toBe(true);
		if (ended.ok) {
			expect(ended.value.state).toBe("complete");
			expect(ended.value.summary).toBe("done");
			expect(ended.value.endedAt).toBeDefined();
		}

		// end(complete)+summary emits a durable `response` activity (storage-owned):
		// action + finding + response.
		const acts = await Planner.getActivities(TEST_BASE, sessionId);
		expect(acts.ok && acts.value.map((a) => a.type)).toEqual([
			"action",
			"finding",
			"response",
		]);
		if (acts.ok) {
			const response = acts.value.find((a) => a.type === "response");
			expect(response?.body).toBe("done");
			expect(response?.ephemeral).toBe(false);
		}
	});

	it("emits a storage-owned response activity only on end(complete)+summary", async () => {
		// error state with a summary → no response activity.
		const errored = await startOn();
		await Planner.endSession(TEST_BASE, errored.sessionId, {
			state: "error",
			summary: "blew up",
		});
		const errActs = await Planner.getActivities(TEST_BASE, errored.sessionId);
		expect(errActs.ok && errActs.value.length).toBe(0);

		// complete without a summary → no response activity.
		const noSummary = await startOn();
		await Planner.endSession(TEST_BASE, noSummary.sessionId, {
			state: "complete",
		});
		const noneActs = await Planner.getActivities(
			TEST_BASE,
			noSummary.sessionId,
		);
		expect(noneActs.ok && noneActs.value.length).toBe(0);
	});

	it("folds/compacts deterministically under same-ms ephemeral writes (rowid tiebreak)", async () => {
		const { sessionId } = await startOn();

		// Three ephemeral rows sharing one created_at. IDs are chosen so that a
		// lexicographic `id DESC` tiebreak would pick the FIRST-written row — only
		// an insertion-ordered rowid tiebreak returns the last-written ("third").
		const sameMs = "2026-07-16T12:00:00.000Z";
		const db = new Database(join(TEST_BASE, "cabane.db"));
		try {
			const insert = (id: string, body: string) =>
				db.run(
					`INSERT INTO agent_activities
             (id, session_id, type, ephemeral, body, created_at)
           VALUES (?, ?, 'progress', 1, ?, ?)`,
					[id, sessionId, body, sameMs],
				);
			insert("ZZZZZZZZZZZZZZZZZZZZZZZZZZ", "first");
			insert("MMMMMMMMMMMMMMMMMMMMMMMMMM", "second");
			insert("AAAAAAAAAAAAAAAAAAAAAAAAAA", "third");
		} finally {
			db.close();
		}

		// Fold returns the last-written ephemeral, not the largest ULID.
		const acts = await Planner.getActivities(TEST_BASE, sessionId);
		expect(acts.ok && acts.value.map((a) => a.body)).toEqual(["third"]);

		// Compaction keeps exactly that row.
		await Planner.endSession(TEST_BASE, sessionId, { state: "complete" });
		expect(countActivities(sessionId)).toBe(1);
		const after = await Planner.getActivities(TEST_BASE, sessionId);
		expect(after.ok && after.value.map((a) => a.body)).toEqual(["third"]);
	});

	it("endSession is idempotent — re-ending a terminal session does not clobber", async () => {
		const { sessionId } = await startOn();
		const first = await Planner.endSession(TEST_BASE, sessionId, {
			state: "complete",
			summary: "done",
		});
		expect(first.ok).toBe(true);
		const firstEndedAt = first.ok ? first.value.endedAt : "";

		// Re-end with different inputs → ok, but the original row is preserved.
		const second = await Planner.endSession(TEST_BASE, sessionId, {
			state: "error",
			summary: "overwrite attempt",
		});
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.value.state).toBe("complete");
			expect(second.value.summary).toBe("done");
			expect(second.value.endedAt).toBe(firstEndedAt);
		}
		// No second response activity was emitted.
		const acts = await Planner.getActivities(TEST_BASE, sessionId);
		expect(
			acts.ok && acts.value.filter((a) => a.type === "response").length,
		).toBe(1);
	});

	it("rejects writes to terminal sessions; revives stale ones", async () => {
		// complete → addActivity rejected.
		const done = await startOn();
		await Planner.endSession(TEST_BASE, done.sessionId, { state: "complete" });
		const onComplete = await Planner.addActivity(TEST_BASE, {
			sessionId: done.sessionId,
			type: "action",
			body: "too late",
		});
		expect(onComplete.ok).toBe(false);

		// error → updateSessionState rejected.
		const errored = await startOn();
		await Planner.endSession(TEST_BASE, errored.sessionId, { state: "error" });
		const reopen = await Planner.updateSessionState(
			TEST_BASE,
			errored.sessionId,
			"active",
		);
		expect(reopen.ok).toBe(false);

		// stale is SOFT: a non-question activity revives it to active.
		const staleA = await startOn();
		await Planner.sweepStaleSessions(TEST_BASE, -60_000);
		const revived = await Planner.addActivity(TEST_BASE, {
			sessionId: staleA.sessionId,
			type: "progress",
			body: "back to work",
		});
		expect(revived.ok).toBe(true);
		const sA = await Planner.getSession(TEST_BASE, staleA.sessionId);
		expect(sA.ok && sA.value?.state).toBe("active");

		// stale + question revives to awaiting_input.
		const staleQ = await startOn();
		await Planner.sweepStaleSessions(TEST_BASE, -60_000);
		await Planner.addActivity(TEST_BASE, {
			sessionId: staleQ.sessionId,
			type: "question",
			context: "self-contained",
			body: "which way?",
		});
		const sQ = await Planner.getSession(TEST_BASE, staleQ.sessionId);
		expect(sQ.ok && sQ.value?.state).toBe("awaiting_input");
	});

	it("bumps last_activity_at on every activity", async () => {
		const { sessionId } = await startOn();
		const before = await Planner.getSession(TEST_BASE, sessionId);
		const startedTs =
			before.ok && before.value ? before.value.lastActivityAt : "";

		// ULIDs + ISO timestamps advance; add an activity and confirm the bump.
		await new Promise((r) => setTimeout(r, 5));
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			body: "tick",
		});

		const after = await Planner.getSession(TEST_BASE, sessionId);
		expect(after.ok && after.value).toBeTruthy();
		if (after.ok && after.value) {
			expect(after.value.lastActivityAt >= startedTs).toBe(true);
			expect(after.value.lastActivityAt).not.toBe(startedTs);
		}
	});

	it("folds ephemeral: durable + latest ephemeral only", async () => {
		const { sessionId } = await startOn();

		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "action",
			body: "durable step",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			ephemeral: true,
			body: "spinner 1",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			ephemeral: true,
			body: "spinner 2",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			ephemeral: true,
			body: "spinner 3",
		});

		// All four are physically present pre-close.
		expect(countActivities(sessionId)).toBe(4);

		const acts = await Planner.getActivities(TEST_BASE, sessionId);
		expect(acts.ok).toBe(true);
		if (acts.ok) {
			// durable step + only the latest spinner
			expect(acts.value.map((a) => a.body)).toEqual([
				"durable step",
				"spinner 3",
			]);
		}
	});

	it("compacts all-but-latest ephemeral on close", async () => {
		const { sessionId } = await startOn();
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "action",
			body: "durable",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			ephemeral: true,
			body: "e1",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "progress",
			ephemeral: true,
			body: "e2",
		});

		expect(countActivities(sessionId)).toBe(3);

		await Planner.endSession(TEST_BASE, sessionId, { state: "complete" });

		// One durable + one surviving ephemeral == 2 physical rows.
		expect(countActivities(sessionId)).toBe(2);

		const acts = await Planner.getActivities(TEST_BASE, sessionId);
		expect(acts.ok && acts.value.map((a) => a.body)).toEqual(["durable", "e2"]);
	});

	it("drives question → awaiting_input → answer → active", async () => {
		const { sessionId } = await startOn();

		const q = await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "question",
			context: "Which auth flow? OAuth vs API key — trade-off is UX vs setup.",
			body: "Which auth flow?",
		});
		const questionId = q.ok ? q.value.id : "";
		let s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("awaiting_input");

		// A decision answering the specific question → active.
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "decision",
			context: answersContext(questionId),
			body: "Going with OAuth",
		});
		s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("active");
	});

	it("batch: stays awaiting_input until every question is answered", async () => {
		const { sessionId } = await startOn();

		const add = async (body: string): Promise<string> => {
			const r = await Planner.addActivity(TEST_BASE, {
				sessionId,
				type: "question",
				body,
			});
			return r.ok ? r.value.id : "";
		};
		const q1 = await add("Q1?");
		const q2 = await add("Q2?");
		const q3 = await add("Q3?");

		// Three unanswered questions → three needs-input rows, one session.
		let queue = await Planner.getNeedsInput(TEST_BASE);
		expect(queue.ok && queue.value.length).toBe(3);

		// Answer the first → session STAYS awaiting_input; two rows remain (q2, q3).
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "decision",
			body: "a1",
			context: answersContext(q1),
		});
		let s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("awaiting_input");
		queue = await Planner.getNeedsInput(TEST_BASE);
		expect(queue.ok && queue.value.length).toBe(2);
		if (queue.ok)
			expect(queue.value.map((r) => r.question?.id)).toEqual([q2, q3]);

		// Answer the remaining two → session flips active; queue empties.
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "decision",
			body: "a2",
			context: answersContext(q2),
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "decision",
			body: "a3",
			context: answersContext(q3),
		});
		s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("active");
		queue = await Planner.getNeedsInput(TEST_BASE);
		expect(queue.ok && queue.value.length).toBe(0);
	});

	it("updateSessionState transitions and bumps last_activity_at", async () => {
		const { sessionId } = await startOn();
		const before = await Planner.getSession(TEST_BASE, sessionId);
		const beforeTs =
			before.ok && before.value ? before.value.lastActivityAt : "";

		await new Promise((r) => setTimeout(r, 5));
		const updated = await Planner.updateSessionState(
			TEST_BASE,
			sessionId,
			"awaiting_input",
		);
		expect(updated.ok && updated.value.state).toBe("awaiting_input");
		if (updated.ok) {
			expect(updated.value.lastActivityAt).not.toBe(beforeTs);
		}
	});

	it("queries sessions by task and state", async () => {
		const { taskId, sessionId } = await startOn();
		await Planner.startSession(TEST_BASE, { taskId, agent: "other" });

		const byTask = await Planner.querySessions(TEST_BASE, { taskId });
		expect(byTask.ok && byTask.value.length).toBe(2);

		await Planner.endSession(TEST_BASE, sessionId, { state: "complete" });
		const complete = await Planner.querySessions(TEST_BASE, {
			state: "complete",
		});
		expect(complete.ok && complete.value.length).toBe(1);
	});

	it("getNeedsInput returns awaiting_input sessions with task + question", async () => {
		const { taskId, sessionId } = await startOn();
		const q = await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "question",
			context: "self-contained question context",
			body: "pick one",
		});
		const questionId = q.ok ? q.value.id : "";

		const queue = await Planner.getNeedsInput(TEST_BASE);
		expect(queue.ok).toBe(true);
		if (queue.ok) {
			expect(queue.value.length).toBe(1);
			expect(queue.value[0]?.session.id).toBe(sessionId);
			expect(queue.value[0]?.task?.id).toBe(taskId);
			expect(queue.value[0]?.question?.body).toBe("pick one");
			expect(queue.value[0]?.question?.id).toBe(questionId);
		}

		// Answering the specific question empties the queue.
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "decision",
			body: "picked",
			context: answersContext(questionId),
		});
		const after = await Planner.getNeedsInput(TEST_BASE);
		expect(after.ok && after.value.length).toBe(0);
	});

	it("cascades: deleting the task removes sessions and activities", async () => {
		const { taskId, sessionId } = await startOn();
		await Planner.addActivity(TEST_BASE, {
			sessionId,
			type: "action",
			body: "work",
		});
		expect(countActivities(sessionId)).toBe(1);

		const del = await Planner.deleteTask(TEST_BASE, taskId);
		expect(del.ok).toBe(true);

		const session = await Planner.getSession(TEST_BASE, sessionId);
		expect(session.ok && session.value).toBeUndefined();
		expect(countActivities(sessionId)).toBe(0);
	});

	it("sweeps idle active/awaiting_input sessions to stale", async () => {
		const { sessionId } = await startOn();

		// Fresh session is not stale under the real threshold.
		const noop = await Planner.sweepStaleSessions(TEST_BASE, SESSION_STALE_MS);
		expect(noop.ok && noop.value.length).toBe(0);

		// Negative threshold pushes the cutoff into the future → everything idle.
		const swept = await Planner.sweepStaleSessions(TEST_BASE, -60_000);
		expect(swept.ok && swept.value.length).toBe(1);
		expect(swept.ok && swept.value[0]?.state).toBe("stale");

		const s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("stale");
	});

	it("sweep never touches completed sessions", async () => {
		const { sessionId } = await startOn();
		await Planner.endSession(TEST_BASE, sessionId, { state: "complete" });

		const swept = await Planner.sweepStaleSessions(TEST_BASE, -60_000);
		expect(swept.ok && swept.value.length).toBe(0);

		const s = await Planner.getSession(TEST_BASE, sessionId);
		expect(s.ok && s.value?.state).toBe("complete");
	});
});

const UPGRADE_BASE = join(import.meta.dir, ".test-data-sessions-upgrade");

/**
 * Seed a pre-S4a DB: the full pre-existing tasks table (with a legacy
 * row) but NO agent_* tables — a faithful on-disk DB from before this slice.
 * The full column set is needed because DBInit re-runs every task index
 * (idx_tasks_scope on scope_uri, etc.) and the tasks FTS triggers.
 */
const seedPreS4aDb = (legacyTaskId: string): void => {
	const db = new Database(join(UPGRADE_BASE, "cabane.db"));
	try {
		db.run(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      short_id TEXT UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'task',
      state TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'normal',
      scope_uri TEXT,
      scope_refs TEXT,
      deadline TEXT,
      defer_until TEXT,
      completed_at TEXT,
      source TEXT NOT NULL DEFAULT 'human',
      source_id TEXT,
      source_url TEXT,
      discovered_at TEXT NOT NULL,
      discovered_by TEXT,
      confidence REAL,
      assignee TEXT,
      parent_task_id TEXT,
      project_id TEXT,
      needs_review INTEGER DEFAULT 0,
      reviewed_at TEXT,
      reviewed_by TEXT,
      evidence TEXT DEFAULT '[]',
      verification TEXT,
      tags TEXT,
      context TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
		db.run(
			`INSERT INTO tasks
         (id, title, kind, state, priority, source, discovered_at, created_at, updated_at)
       VALUES (?, 'legacy issue', 'issue', 'in_progress', 'normal', 'human', ?, ?, ?)`,
			[
				legacyTaskId,
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
			],
		);
	} finally {
		db.close();
	}
};

describe("Planner — Agent Sessions (existing-DB upgrade)", () => {
	beforeEach(() => {
		rmSync(UPGRADE_BASE, { recursive: true, force: true });
		mkdirSync(UPGRADE_BASE, { recursive: true });
	});

	afterEach(() => {
		rmSync(UPGRADE_BASE, { recursive: true, force: true });
	});

	it("upgrades in place: new tables + indexes + FK appear, legacy data untouched", async () => {
		const legacyTaskId = "task-legacy";
		seedPreS4aDb(legacyTaskId);

		// Normal init path — re-runs the prefixed SCHEMA_SQL (IF NOT EXISTS).
		const initResult = await Planner.init(UPGRADE_BASE);
		expect(initResult.ok).toBe(true);

		const db = new Database(join(UPGRADE_BASE, "cabane.db"));
		try {
			db.run("PRAGMA foreign_keys = ON");

			// (1) Both new tables + their indexes now exist (prefixed).
			const tables = (
				db
					.query("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as { name: string }[]
			).map((r) => r.name);
			expect(tables).toContain("agent_sessions");
			expect(tables).toContain("agent_activities");

			const indexes = (
				db
					.query("SELECT name FROM sqlite_master WHERE type = 'index'")
					.all() as { name: string }[]
			).map((r) => r.name);
			expect(indexes).toContain("idx_agent_sessions_task");
			expect(indexes).toContain("idx_agent_sessions_state");
			expect(indexes).toContain("idx_agent_sessions_last_activity");
			expect(indexes).toContain("idx_agent_activities_session");
			expect(indexes).toContain("idx_agent_activities_durable");

			// (2) The new-table→new-table FK enforces: a bogus session_id is rejected.
			expect(() =>
				db.run(
					`INSERT INTO agent_activities
             (id, session_id, type, ephemeral, body, created_at)
           VALUES ('bad', 'no-such-session', 'progress', 0, 'x', '2026-01-01T00:00:00.000Z')`,
				),
			).toThrow();

			// (3) Legacy tasks data is untouched.
			const row = db
				.query("SELECT title, state FROM tasks WHERE id = ?")
				.get(legacyTaskId) as { title: string; state: string };
			expect(row).toEqual({ title: "legacy issue", state: "in_progress" });
		} finally {
			db.close();
		}

		// (2 cont.) The new-table→new-table cascade works: deleting the session
		// row removes its activities via agent_activities.session_id → agent_sessions.
		const started = await Planner.startSession(UPGRADE_BASE, {
			taskId: legacyTaskId,
			agent: "claude",
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await Planner.addActivity(UPGRADE_BASE, {
			sessionId: started.value.id,
			type: "action",
			body: "work",
		});

		const cascadeDb = new Database(join(UPGRADE_BASE, "cabane.db"));
		try {
			cascadeDb.run("PRAGMA foreign_keys = ON");
			cascadeDb.run("DELETE FROM agent_sessions WHERE id = ?", [
				started.value.id,
			]);
			const activityCount = (
				cascadeDb
					.query(
						"SELECT COUNT(*) AS n FROM agent_activities WHERE session_id = ?",
					)
					.get(started.value.id) as { n: number }
			).n;
			expect(activityCount).toBe(0);
		} finally {
			cascadeDb.close();
		}
	});
});
