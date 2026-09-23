/**
 * Planner Storage — Stats & Utilities
 */

import type { Result } from "../result";
import { withDb } from "../runtime";
import { ScopeUri } from "../scope/uri";

import { TABLES } from "./helpers";
import {
	DEFAULT_STALE_THRESHOLD_MS as STALE_IN_PROGRESS_MS,
	Planner as StalePlanner,
} from "./stale";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stored scope_uri values vary for the same logical scope (branch/package
 * extensions, percent-encoding, legacy bare ids). Merge rows down to their
 * base scopeId so every read surface (CLI, tRPC, MCP) sees one entry per scope.
 */
const mergeByScopeId = (
	rows: { scope_uri: string; count: number }[],
): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const scopeIdResult = ScopeUri.getScopeId(row.scope_uri);
		const scopeId = scopeIdResult.ok ? scopeIdResult.value : row.scope_uri;
		counts.set(scopeId, (counts.get(scopeId) ?? 0) + row.count);
	}
	return counts;
};

export namespace Planner {
	export const stats = async (
		basePath: string,
	): Promise<
		Result<{
			totalTasks: number;
			byState: Record<string, number>;
			byScope: Record<string, number>;
			doneToday: number;
			/** Age in days of the oldest inbox task (0 when inbox is empty). */
			oldestInboxDays: number;
			/** In-progress issues untouched for >7d (shared stale helper). */
			staleInProgressCount: number;
			/** Inbox tasks created more than 30 days ago. */
			inboxOver30d: number;
			/** Open tasks that already have a `commit:` work-log ref ("I did this"). */
			probablyDoneCount: number;
		}>
	> => {
		// Reuse the landed stale helper (opens its own connection).
		const staleResult = await StalePlanner.getStaleInProgress(
			basePath,
			STALE_IN_PROGRESS_MS,
		);
		const staleInProgressCount = staleResult.ok ? staleResult.value.length : 0;

		return withDb(basePath, (db) => {
			const totalTasks = (
				db.query(`SELECT COUNT(*) as count FROM ${TABLES.tasks}`).get() as {
					count: number;
				}
			).count;

			const stateRows = db
				.query(
					`SELECT state, COUNT(*) as count FROM ${TABLES.tasks} GROUP BY state`,
				)
				.all() as { state: string; count: number }[];
			const byState: Record<string, number> = {};
			for (const row of stateRows) {
				byState[row.state] = row.count;
			}

			// Count tasks by scope_uri, merged down to base scopeId
			const scopeRows = db
				.query(
					`SELECT scope_uri, COUNT(*) as count FROM ${TABLES.tasks} WHERE scope_uri IS NOT NULL GROUP BY scope_uri`,
				)
				.all() as { scope_uri: string; count: number }[];
			const byScope: Record<string, number> = Object.fromEntries(
				mergeByScopeId(scopeRows),
			);

			const today = new Date().toISOString().slice(0, 10);
			const doneToday = (
				db
					.query(
						`SELECT COUNT(*) as count FROM ${TABLES.tasks} WHERE state = 'done' AND completed_at >= ?`,
					)
					.get(today) as { count: number }
			).count;

			// --- Health digest (JJAK-949) ---
			const now = Date.now();

			const oldestInbox = db
				.query(
					`SELECT MIN(created_at) as oldest FROM ${TABLES.tasks} WHERE state = 'inbox'`,
				)
				.get() as { oldest: string | null };
			const oldestInboxDays = oldestInbox.oldest
				? Math.floor((now - Date.parse(oldestInbox.oldest)) / DAY_MS)
				: 0;

			const thirtyDaysAgo = new Date(now - 30 * DAY_MS).toISOString();
			const inboxOver30d = (
				db
					.query(
						`SELECT COUNT(*) as count FROM ${TABLES.tasks} WHERE state = 'inbox' AND created_at < ?`,
					)
					.get(thirtyDaysAgo) as { count: number }
			).count;

			// Open tasks that already carry a commit: work-log ref. refs is a
			// JSON array serialized without spaces, so match the raw uri prefix.
			const probablyDoneCount = (
				db
					.query(
						`SELECT COUNT(*) as count FROM ${TABLES.tasks} t
						 WHERE t.state NOT IN ('done', 'cancelled')
						   AND EXISTS (
						     SELECT 1 FROM ${TABLES.work_log} w
						     WHERE w.task_id = t.id
						       AND w.refs LIKE '%"uri":"commit:%'
						   )`,
					)
					.get() as { count: number }
			).count;

			return {
				totalTasks,
				byState,
				byScope,
				doneToday,
				oldestInboxDays,
				staleInProgressCount,
				inboxOver30d,
				probablyDoneCount,
			};
		});
	};

	/**
	 * List all unique scopes with task counts, merged by base scopeId.
	 * `scopeUri` is the canonical base URI (no extensions).
	 */
	export const listScopes = async (
		basePath: string,
	): Promise<
		Result<Array<{ scopeUri: string; scopeId: string; count: number }>>
	> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT scope_uri, COUNT(*) as count
           FROM ${TABLES.tasks}
           WHERE scope_uri IS NOT NULL
           GROUP BY scope_uri`,
				)
				.all() as { scope_uri: string; count: number }[];

			return Array.from(mergeByScopeId(rows), ([scopeId, count]) => ({
				scopeUri: ScopeUri.fromScopeId(scopeId),
				scopeId,
				count,
			})).sort((a, b) => b.count - a.count);
		});
	};
}
