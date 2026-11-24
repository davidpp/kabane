/**
 * Reads over the 2.0 record (ADR 0006): what shows, decided when a row is read.
 *
 * Sync apply writes whatever row wins, whatever else has arrived, so a stored
 * row may point at a thread that is deleted, missing, or caught in a parent
 * cycle. These reads are where that is settled, the same way on every device:
 *
 * - a thread that is deleted, or sits under a deleted thread by its stored
 *   parent, is hidden, and so is every member of a cycle holding a deleted
 *   thread;
 * - a thread whose parent has not arrived shows at the root;
 * - in a parent cycle, the member with the lowest id is read as having no
 *   parent, so no thread disappears;
 * - an entry, attribute or ref shows when its thread does, and a link when
 *   both ends do; a removed attribute, link or ref never shows.
 *
 * `VISIBLE_THREADS_SQL` is the common part, a `WITH RECURSIVE` clause ending
 * in `visible_threads(id, parent_id)`, for a read that needs its own query.
 */

import type { z } from "zod";
import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { err, ok, type Result, trySync } from "../result";
import {
	type AttributeRow,
	AttributeRowSchema,
	type EntryRow,
	EntryRowSchema,
	type LinkRow,
	LinkRowSchema,
	type RefRow,
	RefRowSchema,
	type ThreadRow,
	ThreadRowSchema,
} from "../schemas";

/**
 * `hidden`: every deleted thread, and every thread under one along the stored
 * parent edges, cycles included, so a delete hides all a cycle holds before
 * any cycle is broken. `up(start, node)`: every thread a thread reaches
 * through its parents. A thread on a cycle reaches itself, and the cycle's
 * members are all it reaches, so the lowest of them is where the cycle breaks.
 * `UNION` drops the repeated rows a cycle produces, which ends each recursion.
 */
export const VISIBLE_THREADS_SQL = `
WITH RECURSIVE
  hidden(id) AS (
    SELECT id FROM ${TABLES.threads} WHERE deleted_at IS NOT NULL
    UNION
    SELECT t.id FROM ${TABLES.threads} t JOIN hidden h ON t.parent_id = h.id
  ),
  up(start, node) AS (
    SELECT id, parent_id FROM ${TABLES.threads} WHERE parent_id IS NOT NULL
    UNION
    SELECT up.start, t.parent_id FROM up JOIN ${TABLES.threads} t ON t.id = up.node
     WHERE t.parent_id IS NOT NULL
  ),
  breaker(id) AS (
    SELECT start FROM up GROUP BY start
    HAVING SUM(start = node) > 0 AND start = MIN(node)
  ),
  visible_threads(id, parent_id) AS (
    SELECT t.id,
           CASE WHEN b.id IS NOT NULL OR p.id IS NULL THEN NULL ELSE t.parent_id END
      FROM ${TABLES.threads} t
      LEFT JOIN breaker b ON b.id = t.id
      LEFT JOIN ${TABLES.threads} p ON p.id = t.parent_id
     WHERE t.id NOT IN (SELECT id FROM hidden)
  )`;

const rowsOf = <S extends z.ZodType>(
	schema: S,
	read: () => unknown[],
): Result<z.infer<S>[]> => {
	const rows = trySync(read);
	if (!rows.ok) return rows;
	const parsed = schema.array().safeParse(rows.value);
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`A record row does not parse: ${parsed.error.message}`));
};

/** `WHERE <column> = ?` when a thread is given, nothing otherwise. */
const onThread = (column: string, threadId: string | undefined) =>
	threadId === undefined
		? { where: "", params: [] as string[] }
		: { where: `AND ${column} = ?`, params: [threadId] };

export namespace RecordRead {
	/** Visible threads, `parent_id` as it is read: null at the root or where a cycle breaks. */
	export const threads = (db: Db): Result<ThreadRow[]> =>
		rowsOf(ThreadRowSchema, () =>
			db
				.query<Record<string, unknown>, []>(
					`${VISIBLE_THREADS_SQL}
					 SELECT t.*, v.parent_id AS placed_parent_id
					   FROM ${TABLES.threads} t JOIN visible_threads v ON v.id = t.id
					  ORDER BY t.id`,
				)
				.all()
				.map(({ placed_parent_id, ...row }) => ({
					...row,
					parent_id: placed_parent_id,
				})),
		);

	/** Entries on visible threads, in time order. */
	export const entries = (db: Db, threadId?: string): Result<EntryRow[]> => {
		const { where, params } = onThread("e.thread_id", threadId);
		return rowsOf(EntryRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${VISIBLE_THREADS_SQL}
					 SELECT e.* FROM ${TABLES.entries} e
					   JOIN visible_threads v ON v.id = e.thread_id
					  WHERE 1 = 1 ${where}
					  ORDER BY e.created_at, e.id`,
				)
				.all(...params),
		);
	};

	export const attributes = (
		db: Db,
		threadId?: string,
	): Result<AttributeRow[]> => {
		const { where, params } = onThread("a.thread_id", threadId);
		return rowsOf(AttributeRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${VISIBLE_THREADS_SQL}
					 SELECT a.* FROM ${TABLES.attributes} a
					   JOIN visible_threads v ON v.id = a.thread_id
					  WHERE a.removed_at IS NULL ${where}
					  ORDER BY a.thread_id, a.key`,
				)
				.all(...params),
		);
	};

	/** Links whose two ends both show, from or to `threadId` when given. */
	export const links = (db: Db, threadId?: string): Result<LinkRow[]> => {
		const filter =
			threadId === undefined ? "" : "AND (l.source_id = ? OR l.target_id = ?)";
		const params = threadId === undefined ? [] : [threadId, threadId];
		return rowsOf(LinkRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${VISIBLE_THREADS_SQL}
					 SELECT l.* FROM ${TABLES.links} l
					   JOIN visible_threads s ON s.id = l.source_id
					   JOIN visible_threads t ON t.id = l.target_id
					  WHERE l.removed_at IS NULL ${filter}
					  ORDER BY l.id`,
				)
				.all(...params),
		);
	};

	export const refs = (db: Db, threadId?: string): Result<RefRow[]> => {
		const { where, params } = onThread("r.thread_id", threadId);
		return rowsOf(RefRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${VISIBLE_THREADS_SQL}
					 SELECT r.* FROM ${TABLES.refs} r
					   JOIN visible_threads v ON v.id = r.thread_id
					  WHERE r.removed_at IS NULL ${where}
					  ORDER BY r.id`,
				)
				.all(...params),
		);
	};

	/**
	 * Who holds the thread's claim: the earliest `claim` entry, by time and
	 * then id, that no later `release` entry by the same author has released.
	 * Derived on every read and stored nowhere, so two devices that claimed
	 * offline agree on the holder once both entries have arrived.
	 */
	export const claimHolder = (
		db: Db,
		threadId: string,
	): Result<EntryRow | undefined> => {
		const held = rowsOf(EntryRowSchema, () =>
			db
				.query<unknown, [string]>(
					`${VISIBLE_THREADS_SQL}
					 SELECT c.* FROM ${TABLES.entries} c
					   JOIN visible_threads v ON v.id = c.thread_id
					  WHERE c.thread_id = ? AND c.kind = 'claim'
					    AND NOT EXISTS (
					      SELECT 1 FROM ${TABLES.entries} r
					       WHERE r.thread_id = c.thread_id AND r.kind = 'release'
					         AND r.author = c.author
					         AND (r.created_at > c.created_at
					              OR (r.created_at = c.created_at AND r.id > c.id)))
					  ORDER BY c.created_at, c.id
					  LIMIT 1`,
				)
				.all(threadId),
		);
		return held.ok ? ok(held.value[0]) : held;
	};
}
