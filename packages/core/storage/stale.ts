/**
 * Planner Storage — Stale In-Progress Query
 */

import type { Result } from "../result";
import { withDb } from "../runtime";

import type { Task } from "../schemas";
import { rowToTask, TABLES } from "./helpers";

/** Idle threshold before an in-progress issue counts as stale (7 days). Single source — the sweep worker and stats both import this. */
export const DEFAULT_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export namespace Planner {
	/**
	 * Find in-progress issues whose last-touch is older than `thresholdMs`.
	 *
	 * Last-touch = max(tasks.updated_at, latest comment created_at, latest
	 * work-log created_at) — a recent comment or work-log rescues an issue with
	 * an old `updated_at`. Only kind='issue' rows are considered; personal tasks
	 * (kind='task') are never returned.
	 *
	 * ISO-8601 UTC timestamps sort lexicographically, so string MAX/comparison
	 * is chronological.
	 *
	 * Consumed by the stale-sweep workflow and JJAK-949.
	 */
	export const getStaleInProgress = async (
		basePath: string,
		thresholdMs: number,
	): Promise<Result<Task[]>> => {
		const cutoff = new Date(Date.now() - thresholdMs).toISOString();

		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT t.* FROM ${TABLES.tasks} t
					 WHERE t.kind = 'issue'
					   AND t.state = 'in_progress'
					   AND (
					     SELECT MAX(ts) FROM (
					       SELECT t.updated_at AS ts
					       UNION ALL
					       SELECT c.created_at FROM ${TABLES.comments} c WHERE c.task_id = t.id
					       UNION ALL
					       SELECT w.created_at FROM ${TABLES.work_log} w WHERE w.task_id = t.id
					     )
					   ) < ?`,
				)
				.all(cutoff) as Record<string, unknown>[];

			return rows.map(rowToTask);
		});
	};
}
