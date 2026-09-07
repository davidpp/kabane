/**
 * Planner Storage — Proposals
 */

import type { Db } from "../db/port";
import { Events, PLANNER_EVENTS } from "../events";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";
import {
	type Proposal,
	type ProposalDraft,
	ProposalDraftSchema,
	type ProposalQuery,
} from "../schemas";
import { Planner as PlannerComments } from "./comments";
import {
	generateId,
	rowToProposal,
	SHORT_ID_PATTERN,
	TABLES,
	ULID_LENGTH,
} from "./helpers";
import { Planner as PlannerTasks } from "./tasks";

export namespace Planner {
	export const addProposal = async (
		basePath: string,
		draft: ProposalDraft,
	): Promise<Result<Proposal>> => {
		const parseResult = ProposalDraftSchema.safeParse(draft);
		if (!parseResult.success) {
			return err(new Error(`Invalid draft: ${parseResult.error.message}`));
		}

		// Normalize taskId to ULID if it's a short ID (e.g., JJAK-123 → ULID)
		let resolvedTaskId = draft.taskId;
		if (draft.taskId && draft.taskId.length !== ULID_LENGTH) {
			const resolved = await PlannerTasks.resolveTaskId(basePath, draft.taskId);
			if (resolved.ok) resolvedTaskId = resolved.value;
			// If resolution fails, keep the original — better to store than to lose the link
		}

		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.proposals} (
          id, action, status, confidence, summary, reasoning, payload,
          session_id, task_id, context, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.action,
					"pending",
					draft.confidence,
					draft.summary,
					draft.reasoning ?? null,
					JSON.stringify(draft.payload),
					draft.sessionId ?? null,
					resolvedTaskId ?? null,
					draft.context ?? null,
					draft.expiresAt ?? null,
					now,
					now,
				],
			);

			// Note: payload is validated by ProposalDraftSchema.safeParse above
			// The cast is needed because z.input vs z.output types differ for defaults
			return {
				id,
				action: draft.action,
				status: "pending" as const,
				confidence: draft.confidence,
				summary: draft.summary,
				reasoning: draft.reasoning,
				payload: draft.payload as Proposal["payload"],
				sessionId: draft.sessionId,
				taskId: resolvedTaskId,
				context: draft.context,
				expiresAt: draft.expiresAt,
				reviewedAt: undefined,
				reviewNotes: undefined,
				createdAt: now,
				updatedAt: now,
			};
		});
	};

	export const getProposal = async (
		basePath: string,
		id: string,
	): Promise<Result<Proposal | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.proposals} WHERE id = ?`)
				.get(id) as Record<string, unknown> | null;

			return row ? rowToProposal(row) : null;
		});
	};

	export const queryProposals = async (
		basePath: string,
		query: Partial<ProposalQuery> = {},
	): Promise<Result<Proposal[]>> => {
		return withDb(basePath, (db) => {
			const conditions: string[] = [];
			const params: (string | number | null)[] = [];

			if (query.status) {
				conditions.push("status = ?");
				params.push(query.status);
			}

			if (query.action) {
				conditions.push("action = ?");
				params.push(query.action);
			}

			if (query.minConfidence !== undefined) {
				conditions.push("confidence >= ?");
				params.push(query.minConfidence);
			}

			if (!query.includeExpired) {
				conditions.push("(expires_at IS NULL OR expires_at > ?)");
				params.push(new Date().toISOString());
			}

			if (query.taskId !== undefined) {
				conditions.push("task_id = ?");
				params.push(query.taskId);
			}

			const whereClause =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const limit = query.limit ?? 50;
			const offset = query.offset ?? 0;

			const rows = db
				.query(
					`SELECT * FROM ${TABLES.proposals} ${whereClause}
           ORDER BY created_at DESC LIMIT ? OFFSET ?`,
				)
				.all(...params, limit, offset) as Record<string, unknown>[];

			return rows.map(rowToProposal);
		});
	};

	export const approveProposal = async (
		basePath: string,
		id: string,
		notes?: string,
	): Promise<Result<Proposal | null>> => {
		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();

			db.run(
				`UPDATE ${TABLES.proposals} SET status = 'approved', reviewed_at = ?, review_notes = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
				[now, notes ?? null, now, id],
			);

			// Return whether the UPDATE actually changed a row (vs already-approved no-op)
			return (
				Number(
					(db.query("SELECT changes() as c").get() as Record<string, unknown>)
						?.c ?? 0,
				) > 0
			);
		});

		if (!updateResult.ok) return updateResult;
		const wasUpdated = updateResult.value;

		const proposalResult = await getProposal(basePath, id);
		if (!proposalResult.ok) return proposalResult;

		const proposal = proposalResult.value;
		// Only fire side effects if we actually transitioned from pending → approved
		if (proposal && wasUpdated) {
			// Side effect: Add timeline entry for ask_question proposals with taskId
			if (proposal.taskId && proposal.action === "ask_question") {
				const payload = proposal.payload as { question: string };
				const answer = notes ?? "(no answer)";
				await PlannerComments.addComment(basePath, {
					taskId: proposal.taskId,
					author: "system",
					authorType: "ai",
					content: `**Question:** ${payload.question}\n\n**Answer:** ${answer}`,
				});
			}

			// Emit event for proposal status change
			await Events.emit(PLANNER_EVENTS.PROPOSAL_STATUS_CHANGED, {
				proposalId: proposal.id,
				taskId: proposal.taskId,
				status: "approved",
				answer: notes,
			});
		}

		return proposalResult;
	};

	export const rejectProposal = async (
		basePath: string,
		id: string,
		notes?: string,
	): Promise<Result<Proposal | null>> => {
		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();

			db.run(
				`UPDATE ${TABLES.proposals} SET status = 'rejected', reviewed_at = ?, review_notes = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
				[now, notes ?? null, now, id],
			);

			// Return whether the UPDATE actually changed a row (vs already-rejected no-op)
			return (
				Number(
					(db.query("SELECT changes() as c").get() as Record<string, unknown>)
						?.c ?? 0,
				) > 0
			);
		});

		if (!updateResult.ok) return updateResult;
		const wasUpdated = updateResult.value;

		const proposalResult = await getProposal(basePath, id);
		if (!proposalResult.ok) return proposalResult;

		const proposal = proposalResult.value;
		// Only fire side effects if we actually transitioned from pending → rejected
		if (proposal && wasUpdated) {
			// Side effect: Add timeline entry for ask_question proposals with taskId
			if (proposal.taskId && proposal.action === "ask_question") {
				const payload = proposal.payload as { question: string };
				await PlannerComments.addComment(basePath, {
					taskId: proposal.taskId,
					author: "system",
					authorType: "ai",
					content: `**Question:** ${payload.question}\n\n*Skipped*${notes ? ` — ${notes}` : ""}`,
				});
			}

			// Emit event for proposal status change
			await Events.emit(PLANNER_EVENTS.PROPOSAL_STATUS_CHANGED, {
				proposalId: proposal.id,
				taskId: proposal.taskId,
				status: "rejected",
				reason: notes,
			});
		}

		return proposalResult;
	};

	/**
	 * Reopen a resolved proposal (approved/rejected) back to pending.
	 * Clears review status so the user can re-answer or change their decision.
	 * Only proposals with status 'approved' or 'rejected' can be reopened.
	 *
	 * Uses a conditional UPDATE within a single transaction to prevent TOCTOU races.
	 */
	export const reopenProposal = async (
		basePath: string,
		id: string,
	): Promise<Result<Proposal | null>> => {
		// Use a single DB connection to atomically check status and update
		const transactionResult = await withDb(basePath, (db) => {
			// First, get the current proposal to capture previous status
			const row = db
				.query(`SELECT * FROM ${TABLES.proposals} WHERE id = ?`)
				.get(id) as Record<string, unknown> | null;

			if (!row) {
				return { found: false, updated: false } as const;
			}

			const currentStatus = row.status as string;

			// Validate status within the same connection (no race window)
			if (currentStatus !== "approved" && currentStatus !== "rejected") {
				return {
					found: true,
					updated: false,
					error: `Cannot reopen proposal with status '${currentStatus}'. Only approved or rejected proposals can be reopened.`,
				} as const;
			}

			// Atomic conditional update - only updates if status is still approved/rejected
			const now = new Date().toISOString();
			const result = db.run(
				`UPDATE ${TABLES.proposals}
				 SET status = 'pending', reviewed_at = NULL, review_notes = NULL, updated_at = ?
				 WHERE id = ? AND (status = 'approved' OR status = 'rejected')`,
				[now, id],
			);

			if (result.changes === 0) {
				// Status changed between read and update (concurrent modification)
				return {
					found: true,
					updated: false,
					error: "Proposal status was modified concurrently. Please try again.",
				} as const;
			}

			// Re-read to get the updated proposal
			const updatedRow = db
				.query(`SELECT * FROM ${TABLES.proposals} WHERE id = ?`)
				.get(id) as Record<string, unknown>;

			return {
				found: true,
				updated: true,
				proposal: rowToProposal(updatedRow),
				previousStatus: currentStatus,
				action: row.action as string,
				taskId: row.task_id as string | null,
				payload: JSON.parse(row.payload as string),
			} as const;
		});

		if (!transactionResult.ok) return transactionResult;

		const txResult = transactionResult.value;

		if (!txResult.found) {
			return { ok: true, value: null };
		}

		if (!txResult.updated) {
			return {
				ok: false,
				error: new Error(txResult.error),
			};
		}

		const proposal = txResult.proposal;

		// Side effect: Add timeline entry for ask_question proposals with taskId
		if (txResult.taskId && txResult.action === "ask_question") {
			const payload = txResult.payload as { question: string };
			await PlannerComments.addComment(basePath, {
				taskId: txResult.taskId,
				author: "system",
				authorType: "ai",
				content: `**Question reopened:** ${payload.question}\n\n*Previous answer cleared — awaiting new response*`,
			});
		}

		// Emit event for proposal status change
		await Events.emit(PLANNER_EVENTS.PROPOSAL_STATUS_CHANGED, {
			proposalId: proposal.id,
			taskId: proposal.taskId,
			status: "pending",
			previousStatus: txResult.previousStatus,
		});

		return { ok: true, value: proposal };
	};

	/**
	 * Resolve a task ID to both its ULID and short ID for querying proposals.
	 *
	 * Returns an array of IDs to query:
	 * - [ulid, shortId] if both exist (enables bi-directional lookup)
	 * - [input] if only one format known or for arbitrary strings
	 *
	 * Takes an existing DB connection to avoid opening a second connection.
	 */
	const resolveTaskIdPairWithDb = (db: Db, taskId: string): string[] => {
		// Full ULID - query to get short ID
		if (taskId.length === ULID_LENGTH) {
			const row = db
				.query(`SELECT short_id FROM ${TABLES.tasks} WHERE id = ?`)
				.get(taskId) as { short_id: string | null } | null;
			if (row?.short_id) return [taskId, row.short_id];
			return [taskId];
		}

		// Short ID format (JDES-123 pattern)
		if (SHORT_ID_PATTERN.test(taskId)) {
			const row = db
				.query(
					`SELECT id FROM ${TABLES.tasks} WHERE short_id = ? COLLATE NOCASE`,
				)
				.get(taskId.toUpperCase()) as { id: string } | null;
			if (row) return [row.id, taskId.toUpperCase()];
			return [taskId];
		}

		// Arbitrary string - pass through for exact-match query
		return [taskId];
	};

	/**
	 * Get all proposals for a specific task/issue (pending + resolved).
	 * Used for displaying proposals inline in the issue timeline.
	 *
	 * Accepts both ULID and short ID (e.g., JJAK-123) as input.
	 * Queries both formats to handle proposals stored before ULID normalization.
	 *
	 * Note: Uses a single DB connection for ID resolution and query to avoid overhead.
	 */
	export const getProposalsForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<Proposal[]>> => {
		// Use a single DB connection for both ID resolution and proposal query
		return withDb(basePath, (db) => {
			const ids = resolveTaskIdPairWithDb(db, taskId);

			if (ids.length === 1) {
				const rows = db
					.query(
						`SELECT * FROM ${TABLES.proposals}
             WHERE task_id = ?
             ORDER BY created_at ASC`,
					)
					.all(ids[0]) as Record<string, unknown>[];
				return rows.map(rowToProposal);
			}

			// Query both ULID and short ID to catch proposals stored in either format
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.proposals}
           WHERE task_id IN (?, ?)
           ORDER BY created_at ASC`,
				)
				.all(...ids) as Record<string, unknown>[];
			return rows.map(rowToProposal);
		});
	};

	/**
	 * Get all pending proposals belonging to a question group.
	 *
	 * A question group is identified by a shared groupId in the ask_question payload.
	 * Returns proposals ordered by questionIndex for display.
	 */
	export const getQuestionGroup = async (
		basePath: string,
		groupId: string,
	): Promise<Result<Proposal[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.proposals}
				 WHERE action = 'ask_question'
				   AND json_extract(payload, '$.groupId') = ?
				 ORDER BY json_extract(payload, '$.questionIndex') ASC, created_at ASC`,
				)
				.all(groupId) as Record<string, unknown>[];

			return rows.map(rowToProposal);
		});
	};

	/**
	 * Resolve all pending questions in a group by applying their default answers.
	 *
	 * Used by "Apply all defaults" in the dashboard. Only resolves proposals
	 * that are still pending and have a defaultAnswer in their payload.
	 * Returns the count of resolved proposals.
	 */
	export const resolveQuestionGroup = async (
		basePath: string,
		groupId: string,
	): Promise<Result<{ resolved: number; skipped: number; failed: number }>> => {
		const groupResult = await getQuestionGroup(basePath, groupId);
		if (!groupResult.ok) return groupResult;

		const proposals = groupResult.value;

		// Only consider pending proposals — already-resolved ones are not "skipped"
		const pending = proposals.filter((p) => p.status === "pending");
		const resolvable = pending.filter(
			(p) => p.payload.action === "ask_question" && !!p.payload.defaultAnswer,
		);

		// noDefault = pending proposals that lack a default answer (can't auto-resolve)
		const noDefault = pending.length - resolvable.length;

		// Resolve sequentially — each approveProposal opens its own SQLite transaction,
		// and parallel writes risk lock contention on single-writer SQLite.
		let resolved = 0;
		let failed = 0;
		for (const p of resolvable) {
			const { payload } = p;
			// Type guard: filter guarantees ask_question + defaultAnswer, but TS can't narrow through .filter()
			if (payload.action !== "ask_question" || !payload.defaultAnswer) continue;
			const result = await approveProposal(
				basePath,
				p.id,
				payload.defaultAnswer,
			);
			if (result.ok) resolved++;
			else failed++;
		}

		// skipped = proposals without defaults (can't auto-resolve), disjoint from failed
		return ok({ resolved, skipped: noDefault, failed });
	};
}
