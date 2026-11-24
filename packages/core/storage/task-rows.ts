/**
 * The old task row for a few threads, read without walking the record.
 *
 * The `tasks` view decides what shows over the whole record, which a listing
 * needs and a read of one task does not: on a deep tree it walks every
 * thread's ancestry. A point read here decides each named thread by its own
 * ancestry (`RecordRead.visibleAmongSql`) and places its parent the way the
 * whole-record read does: null when the parent has not arrived, or when the
 * thread is where its parent cycle breaks (the cycle's lowest id).
 */

import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { RecordRead } from "./record";

type Row = Record<string, unknown>;

export namespace TaskRows {
	/** Visible task rows for the thread ids `seed` (SQL over `params`) names. */
	export const where = (db: Db, seed: string, params: string[]): Row[] =>
		db
			.query<Row, string[]>(
				`${RecordRead.visibleAmongSql(seed)},
				 up(start, node) AS (
				   SELECT t.id, t.parent_id FROM ${TABLES.threads} t
				    WHERE t.id IN (SELECT id FROM visible_threads) AND t.parent_id IS NOT NULL
				   UNION
				   SELECT up.start, t.parent_id FROM up JOIN ${TABLES.threads} t ON t.id = up.node
				    WHERE t.parent_id IS NOT NULL
				 ),
				 breaker(id) AS (
				   SELECT start FROM up GROUP BY start
				   HAVING SUM(start = node) > 0 AND start = MIN(node)
				 )
				 SELECT r.*,
				        CASE WHEN b.id IS NOT NULL OR p.id IS NULL THEN NULL
				             ELSE r.parent_task_id END AS placed_parent
				   FROM ${TABLES.task_rows} r
				   JOIN visible_threads v ON v.id = r.id
				   LEFT JOIN breaker b ON b.id = r.id
				   LEFT JOIN ${TABLES.threads} p ON p.id = r.parent_task_id`,
			)
			.all(...params)
			.map(({ placed_parent, ...row }) => ({
				...row,
				parent_task_id: placed_parent,
			}));

	/** The visible task row `id` or `short_id` names, or undefined. */
	export const byIdOrShortId = (db: Db, key: string): Row | undefined =>
		where(db, `SELECT id FROM ${TABLES.threads} WHERE id = ? OR short_id = ?`, [
			key,
			key,
		])[0];

	export const byIds = (db: Db, ids: readonly string[]): Row[] =>
		ids.length === 0
			? []
			: where(
					db,
					`SELECT id FROM ${TABLES.threads} WHERE id IN (${ids.map(() => "?").join(", ")})`,
					[...ids],
				);
}
