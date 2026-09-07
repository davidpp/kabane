/**
 * Planner Storage — Agent Sessions (S4a)
 *
 * The container for agent work: sessions with a lifecycle + typed activities.
 * Pure addition — nothing on the task/comment/work-log paths calls in here;
 * sessions are OPTIONAL FOREVER.
 *
 * Ephemeral semantics: writes are append-only. The "latest ephemeral" fold
 * happens at query time (getActivities) and compaction (delete all-but-latest
 * ephemeral) runs inside the endSession transaction — never on the write path.
 */

import type { Db } from "../db/port";
import { err, type Result } from "../result";
import { withDb } from "../runtime";

import {
	type AgentActivity,
	type AgentActivityDraft,
	AgentActivityDraftSchema,
	type AgentSession,
	type AgentSessionDraft,
	AgentSessionDraftSchema,
	type SessionQuery,
	type Task,
} from "../schemas";
import {
	generateId,
	rowToAgentActivity,
	rowToSession,
	rowToTask,
	TABLES,
} from "./helpers";

/**
 * Idle threshold before an active/awaiting_input session counts as stale (24h).
 * Distinct from DEFAULT_STALE_THRESHOLD_MS (stale.ts, 7d) — that's for issue
 * states; this is for agent sessions. Different concepts, different constants.
 */
export const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Terminal states — a session that reached one is closed for writes.
 * addActivity/updateSessionState reject writes to a terminal session (no
 * revival). `stale` is deliberately NOT terminal: it's a soft idle marker that
 * any subsequent activity revives (see addActivity).
 */
const TERMINAL_STATES = new Set(["complete", "error"]);
const isTerminal = (state: string): boolean => TERMINAL_STATES.has(state);

/**
 * Count `question` activities on a session that have NO answering `decision`.
 * A decision answers a question when its `context` is exactly
 * `answers <question-activity-id>` (see schemas/question-body.ts → answersContext).
 * The unit of "needs answering" is the unanswered QUESTION, not the session:
 * a batch of N questions stays blocked until every one has an answer.
 */
const countUnansweredQuestions = (db: Db, sessionId: string): number => {
	const row = db
		.query(
			`SELECT COUNT(*) AS n FROM ${TABLES.agent_activities} q
       WHERE q.session_id = ? AND q.type = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM ${TABLES.agent_activities} d
           WHERE d.session_id = q.session_id AND d.type = 'decision'
             AND d.context = 'answers ' || q.id
         )`,
		)
		.get(sessionId) as { n: number };
	return row.n;
};

/**
 * A row on the blocked-on-human queue: ONE unanswered `question` activity, joined
 * to its session and task. A batch session with N unanswered questions yields N
 * rows (the unit is the question, not the session), each carrying its own
 * `question` activity (answer it via answerQuestion with `question.id`).
 */
export type NeedsInputItem = {
	session: AgentSession;
	task: Task | undefined;
	/** The unanswered `question` activity this row represents. */
	question: AgentActivity | undefined;
};

export namespace Planner {
	/** Start a session (defaults to state="active"). */
	export const startSession = async (
		basePath: string,
		draft: AgentSessionDraft,
	): Promise<Result<AgentSession>> => {
		const parsed = AgentSessionDraftSchema.safeParse(draft);
		if (!parsed.success) return err(new Error(parsed.error.message));

		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();
			const s = parsed.data;

			db.run(
				`INSERT INTO ${TABLES.agent_sessions}
           (id, task_id, agent, state, external_ref, summary, started_at, last_activity_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				[id, s.taskId, s.agent, s.state, s.externalRef ?? null, null, now, now],
			);

			return {
				id,
				taskId: s.taskId,
				agent: s.agent,
				state: s.state,
				externalRef: s.externalRef,
				startedAt: now,
				lastActivityAt: now,
			};
		});
	};

	/** Fetch a single session by id. */
	export const getSession = async (
		basePath: string,
		sessionId: string,
	): Promise<Result<AgentSession | undefined>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
				.get(sessionId) as Record<string, unknown> | null;
			return row ? rowToSession(row) : undefined;
		});
	};

	/**
	 * Transition a session's state. Bumps last_activity_at (every transition
	 * counts as activity). Use endSession for terminal states + compaction.
	 * Read + guard + write run in ONE transaction (no TOCTOU): a terminal
	 * (complete|error) session rejects the transition.
	 */
	export const updateSessionState = async (
		basePath: string,
		sessionId: string,
		state: string,
	): Promise<Result<AgentSession>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const runTxn = db.transaction(() => {
				const current = db
					.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
					.get(sessionId) as Record<string, unknown> | null;
				if (!current) throw new Error(`Session not found: ${sessionId}`);
				if (isTerminal(current.state as string)) {
					throw new Error(
						`Cannot transition a ${current.state} session (terminal): ${sessionId}`,
					);
				}

				db.run(
					`UPDATE ${TABLES.agent_sessions}
           SET state = ?, last_activity_at = ?
           WHERE id = ?`,
					[state, now, sessionId],
				);

				const row = db
					.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
					.get(sessionId) as Record<string, unknown> | null;
				if (!row) throw new Error(`Session not found: ${sessionId}`);
				return rowToSession(row);
			});
			return runTxn();
		});
	};

	/**
	 * End a session (one transaction): sets terminal state + ended_at, optionally
	 * a summary; on end(complete) with a summary emits a durable `response`
	 * activity (the final word on the timeline — all surfaces behave identically);
	 * then compacts ephemeral activities (delete all-but-latest).
	 *
	 * Idempotent: re-ending an already-terminal session returns the existing row
	 * unchanged (no ended_at/state/summary clobber, no second response, no
	 * re-compaction).
	 */
	export const endSession = async (
		basePath: string,
		sessionId: string,
		input: { state: string; summary?: string },
	): Promise<Result<AgentSession>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();

			const runTxn = db.transaction(() => {
				const existing = db
					.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
					.get(sessionId) as Record<string, unknown> | null;
				if (!existing) throw new Error(`Session not found: ${sessionId}`);

				// Idempotent: already terminal → return as-is, no clobber.
				if (isTerminal(existing.state as string)) {
					return rowToSession(existing);
				}

				if (input.summary !== undefined) {
					db.run(
						`UPDATE ${TABLES.agent_sessions}
             SET state = ?, summary = ?, ended_at = ?, last_activity_at = ?
             WHERE id = ?`,
						[input.state, input.summary, now, now, sessionId],
					);
				} else {
					db.run(
						`UPDATE ${TABLES.agent_sessions}
             SET state = ?, ended_at = ?, last_activity_at = ?
             WHERE id = ?`,
						[input.state, now, now, sessionId],
					);
				}

				// end(complete) + summary → durable `response` activity (PRD: the
				// final response lands on the timeline). Durable (ephemeral=0), so
				// the compaction below never touches it.
				if (input.summary !== undefined && input.state === "complete") {
					db.run(
						`INSERT INTO ${TABLES.agent_activities}
               (id, session_id, type, ephemeral, severity, category, context, body, created_at)
             VALUES (?, ?, 'response', 0, NULL, NULL, NULL, ?, ?)`,
						[generateId(), sessionId, input.summary, now],
					);
				}

				// Compact: keep only the latest ephemeral activity (rowid breaks
				// same-ms created_at ties deterministically — see getActivities).
				db.run(
					`DELETE FROM ${TABLES.agent_activities}
           WHERE session_id = ? AND ephemeral = 1
             AND id NOT IN (
               SELECT id FROM ${TABLES.agent_activities}
               WHERE session_id = ? AND ephemeral = 1
               ORDER BY created_at DESC, rowid DESC LIMIT 1
             )`,
					[sessionId, sessionId],
				);

				const row = db
					.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
					.get(sessionId) as Record<string, unknown> | null;
				if (!row) throw new Error(`Session not found: ${sessionId}`);
				return rowToSession(row);
			});
			return runTxn();
		});
	};

	/**
	 * Append an activity and drive the session state machine. Read + guard +
	 * write run in ONE transaction (no TOCTOU), bumping session.last_activity_at:
	 *   - terminal (complete|error) → REJECTED (no revival of a closed session);
	 *   - `question` activity → awaiting_input (blocks on human);
	 *   - any non-question activity on an awaiting_input session → active (answer);
	 *   - `stale` is SOFT — any activity revives it: a `question` → awaiting_input,
	 *     otherwise → active (a stale session is idle, not closed).
	 */
	export const addActivity = async (
		basePath: string,
		draft: AgentActivityDraft,
	): Promise<Result<AgentActivity>> => {
		const parsed = AgentActivityDraftSchema.safeParse(draft);
		if (!parsed.success) return err(new Error(parsed.error.message));

		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();
			const a = parsed.data;

			const runTxn = db.transaction(() => {
				const sessionRow = db
					.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
					.get(a.sessionId) as Record<string, unknown> | null;
				if (!sessionRow) throw new Error(`Session not found: ${a.sessionId}`);
				const currentState = sessionRow.state as string;

				// Terminal sessions are closed — no activity, no revival.
				if (isTerminal(currentState)) {
					throw new Error(
						`Cannot add activity to a ${currentState} session (terminal): ${a.sessionId}`,
					);
				}

				// Insert first so the unanswered-question check below counts this
				// activity (e.g. an answering `decision` clears the block it closes).
				db.run(
					`INSERT INTO ${TABLES.agent_activities}
             (id, session_id, type, ephemeral, severity, category, context, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						a.sessionId,
						a.type,
						a.ephemeral ? 1 : 0,
						a.severity ?? null,
						a.category ?? null,
						a.context ?? null,
						a.body,
						now,
					],
				);

				// A `question` blocks on input. A non-question activity on an
				// awaiting_input OR stale session clears the block ONLY when no
				// unanswered question activities remain — a batch of N questions stays
				// awaiting_input until every one has an answering decision (the unit of
				// "needs answering" is the unanswered QUESTION, not the session).
				let nextState = currentState;
				if (a.type === "question") {
					nextState = "awaiting_input";
				} else if (
					currentState === "awaiting_input" ||
					currentState === "stale"
				) {
					nextState =
						countUnansweredQuestions(db, a.sessionId) === 0
							? "active"
							: "awaiting_input";
				}

				db.run(
					`UPDATE ${TABLES.agent_sessions}
           SET state = ?, last_activity_at = ?
           WHERE id = ?`,
					[nextState, now, a.sessionId],
				);
			});
			runTxn();

			return {
				id,
				sessionId: a.sessionId,
				type: a.type,
				ephemeral: a.ephemeral,
				severity: a.severity,
				category: a.category,
				context: a.context,
				body: a.body,
				createdAt: now,
			};
		});
	};

	/**
	 * THE shared read: durable activities + the latest ephemeral only, ordered
	 * chronologically. S5's fold and S3's Discussion both consume this.
	 */
	export const getActivities = async (
		basePath: string,
		sessionId: string,
	): Promise<Result<AgentActivity[]>> => {
		return withDb(basePath, (db) => {
			// rowid (sqlite insertion order) breaks same-ms created_at ties — ULIDs
			// are non-monotonic within a millisecond, so id DESC would pick a random
			// same-ms row, not the last-written one. Compaction uses the same order.
			const durable = db
				.query(
					`SELECT rowid, * FROM ${TABLES.agent_activities}
           WHERE session_id = ? AND ephemeral = 0
           ORDER BY created_at ASC, rowid ASC`,
				)
				.all(sessionId) as Record<string, unknown>[];

			const latestEphemeral = db
				.query(
					`SELECT rowid, * FROM ${TABLES.agent_activities}
           WHERE session_id = ? AND ephemeral = 1
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(sessionId) as Record<string, unknown> | null;

			const rows = latestEphemeral ? [...durable, latestEphemeral] : durable;
			rows.sort((x, y) => {
				const cx = x.created_at as string;
				const cy = y.created_at as string;
				if (cx !== cy) return cx < cy ? -1 : 1;
				return (x.rowid as number) - (y.rowid as number);
			});

			return rows.map(rowToAgentActivity);
		});
	};

	/** Query sessions by task and/or state, most-recently-active first. */
	export const querySessions = async (
		basePath: string,
		query: SessionQuery = {},
	): Promise<Result<AgentSession[]>> => {
		return withDb(basePath, (db) => {
			const conditions: string[] = [];
			const params: string[] = [];
			if (query.taskId) {
				conditions.push("task_id = ?");
				params.push(query.taskId);
			}
			if (query.state) {
				conditions.push("state = ?");
				params.push(query.state);
			}
			if (query.externalRef) {
				conditions.push("external_ref = ?");
				params.push(query.externalRef);
			}
			const where =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

			const rows = db
				.query(
					`SELECT * FROM ${TABLES.agent_sessions}
           ${where}
           ORDER BY last_activity_at DESC`,
				)
				.all(...params) as Record<string, unknown>[];

			return rows.map(rowToSession);
		});
	};

	/**
	 * The blocked-on-human queue: ONE row per UNANSWERED `question` activity on an
	 * awaiting_input session, joined to its session + task. A batch of N questions
	 * surfaces N answerable rows (unanswered = a question with no `decision` whose
	 * context is `answers <question-id>`). Ordered by session recency, then the
	 * questions' own order within a session.
	 */
	export const getNeedsInput = async (
		basePath: string,
	): Promise<Result<NeedsInputItem[]>> => {
		return withDb(basePath, (db) => {
			const questionRows = db
				.query(
					`SELECT q.* FROM ${TABLES.agent_activities} q
           JOIN ${TABLES.agent_sessions} s ON s.id = q.session_id
           WHERE s.state = 'awaiting_input' AND q.type = 'question'
             AND NOT EXISTS (
               SELECT 1 FROM ${TABLES.agent_activities} d
               WHERE d.session_id = q.session_id AND d.type = 'decision'
                 AND d.context = 'answers ' || q.id
             )
           ORDER BY s.last_activity_at DESC, q.created_at ASC, q.rowid ASC`,
				)
				.all() as Record<string, unknown>[];

			// Cache session + task lookups shared across a batch's rows.
			const sessionCache = new Map<string, AgentSession>();
			const taskCache = new Map<string, Task | undefined>();

			return questionRows.map((questionRow) => {
				const question = rowToAgentActivity(questionRow);

				let session = sessionCache.get(question.sessionId);
				if (!session) {
					const sessionRow = db
						.query(`SELECT * FROM ${TABLES.agent_sessions} WHERE id = ?`)
						.get(question.sessionId) as Record<string, unknown>;
					session = rowToSession(sessionRow);
					sessionCache.set(question.sessionId, session);
				}

				if (!taskCache.has(session.taskId)) {
					const taskRow = db
						.query(`SELECT * FROM ${TABLES.tasks} WHERE id = ?`)
						.get(session.taskId) as Record<string, unknown> | null;
					taskCache.set(
						session.taskId,
						taskRow ? rowToTask(taskRow) : undefined,
					);
				}

				return { session, task: taskCache.get(session.taskId), question };
			});
		});
	};

	/**
	 * Mark active/awaiting_input sessions idle beyond `thresholdMs` as stale.
	 * The staleness clock (last_activity_at) is preserved — marking stale does
	 * NOT bump it. Returns the swept sessions. S6's scheduled workflow calls this.
	 */
	export const sweepStaleSessions = async (
		basePath: string,
		thresholdMs: number,
	): Promise<Result<AgentSession[]>> => {
		const cutoff = new Date(Date.now() - thresholdMs).toISOString();

		return withDb(basePath, (db) => {
			// SELECT + UPDATE in one txn: a session bumped between the two would
			// otherwise be reported stale here yet survive the WHERE on UPDATE.
			const runTxn = db.transaction(() => {
				const rows = db
					.query(
						`SELECT * FROM ${TABLES.agent_sessions}
             WHERE state IN ('active', 'awaiting_input')
               AND last_activity_at < ?`,
					)
					.all(cutoff) as Record<string, unknown>[];

				if (rows.length === 0) return [];

				db.run(
					`UPDATE ${TABLES.agent_sessions}
           SET state = 'stale'
           WHERE state IN ('active', 'awaiting_input')
             AND last_activity_at < ?`,
					[cutoff],
				);

				return rows.map((row) => ({ ...rowToSession(row), state: "stale" }));
			});
			return runTxn();
		});
	};
}
