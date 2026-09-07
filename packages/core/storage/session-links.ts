/**
 * Planner Storage — Session-Issue Linking
 */

import type { Result } from "../result";
import { withDb } from "../runtime";

import type { Task, TaskWorkLog } from "../schemas";
import { rowToTask, TABLES } from "./helpers";
import { Planner as PlannerWorkLogs } from "./work-logs";

export namespace Planner {
	/**
	 * Link an issue to a session by creating a work log with a session ref.
	 */
	export const linkIssueToSession = async (
		basePath: string,
		input: {
			taskId: string;
			sessionId: string;
			note?: string;
			addedBy?: string;
			addedByType?: "human" | "ai";
		},
	): Promise<Result<TaskWorkLog>> => {
		return PlannerWorkLogs.addWorkLog(basePath, {
			taskId: input.taskId,
			refs: [{ uri: `session:${input.sessionId}`, label: "Session link" }],
			note: input.note,
			addedBy: input.addedBy,
			addedByType: input.addedByType,
		});
	};

	/**
	 * Unlink an issue from a session by removing work logs with that session ref.
	 */
	export const unlinkIssueFromSession = async (
		basePath: string,
		taskId: string,
		sessionId: string,
	): Promise<Result<void>> => {
		const sessionUri = `session:${sessionId}`;
		return withDb(basePath, (db) => {
			// Delete work logs for this task that contain the session ref
			db.run(
				`DELETE FROM ${TABLES.work_log} WHERE task_id = ? AND refs LIKE ?`,
				[taskId, `%${sessionUri}%`],
			);
		});
	};

	/**
	 * Get issues linked to a specific session via work logs.
	 * Session links are stored as work log refs with URI pattern "session:<sessionId>".
	 */
	export const getIssuesForSession = async (
		basePath: string,
		sessionId: string,
	): Promise<Result<Task[]>> => {
		return withDb(basePath, (db) => {
			const sessionUri = `session:${sessionId}`;

			const rows = db
				.query(
					`SELECT DISTINCT t.* FROM ${TABLES.tasks} t
           JOIN ${TABLES.work_log} wl ON t.id = wl.task_id
           WHERE wl.refs LIKE ?
           AND t.kind = 'issue'
           ORDER BY t.created_at DESC`,
				)
				.all(`%${sessionUri}%`) as Record<string, unknown>[];

			return rows.map(rowToTask);
		});
	};
}
