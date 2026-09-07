/**
 * Planner Storage — Context Refs
 *
 * A curated registry of input context refs per task (the *input* side of an
 * issue), distinct from the append-only work log. Re-promoting the same
 * (task_id, uri) upserts kind/label/note/added_at.
 */

import type { Result } from "../result";
import { withDb } from "../runtime";

import type { AddContextRefInput, TaskContextRef } from "../schemas";
import { generateId, rowToContextRef, TABLES } from "./helpers";
import { Planner as PlannerWorkLogs } from "./work-logs";

export namespace Planner {
	/**
	 * Add (or upsert) a curated context ref. Re-adding the same (task_id, uri)
	 * updates kind/label/note/added_at rather than throwing.
	 */
	export const addContextRef = async (
		basePath: string,
		input: AddContextRefInput,
	): Promise<Result<TaskContextRef>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.context_refs}
           (id, task_id, uri, kind, label, note, added_by, added_by_type, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, uri) DO UPDATE SET
           kind = excluded.kind,
           label = excluded.label,
           note = excluded.note,
           added_at = excluded.added_at`,
				[
					id,
					input.taskId,
					input.uri,
					input.kind,
					input.label ?? null,
					input.note ?? null,
					input.addedBy ?? null,
					input.addedByType ?? null,
					now,
				],
			);

			const row = db
				.query(
					`SELECT * FROM ${TABLES.context_refs} WHERE task_id = ? AND uri = ?`,
				)
				.get(input.taskId, input.uri) as Record<string, unknown>;

			return rowToContextRef(row);
		});
	};

	/**
	 * Get the curated context refs for a task, oldest first.
	 */
	export const getContextRefs = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskContextRef[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.context_refs} WHERE task_id = ? ORDER BY added_at ASC`,
				)
				.all(taskId) as Record<string, unknown>[];

			return rows.map(rowToContextRef);
		});
	};

	/**
	 * Remove a context ref from the registry by id. Never touches work logs.
	 */
	export const deleteContextRef = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			db.run(`DELETE FROM ${TABLES.context_refs} WHERE id = ?`, [id]);
		});
	};

	/**
	 * Promote a ref into the curated context AND record it in the work log —
	 * one call, two rows. Mirrors linkIssueToSession's two-write composition.
	 */
	export const promoteToContext = async (
		basePath: string,
		input: {
			taskId: string;
			uri: string;
			kind: string;
			label?: string;
			note?: string;
			addedBy?: string;
			addedByType?: "human" | "ai";
		},
	): Promise<Result<TaskContextRef>> => {
		const logResult = await PlannerWorkLogs.addWorkLog(basePath, {
			taskId: input.taskId,
			refs: [{ uri: input.uri, label: input.label }],
			note: input.note,
			addedBy: input.addedBy,
			addedByType: input.addedByType,
		});
		if (!logResult.ok) return logResult;

		return addContextRef(basePath, {
			taskId: input.taskId,
			uri: input.uri,
			kind: input.kind,
			label: input.label,
			note: input.note,
			addedBy: input.addedBy,
			addedByType: input.addedByType,
		});
	};
}
