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
 * - an entry, attribute or ref shows when its thread does, and a ref to a
 *   thread (a link) only when that thread shows too; a removed attribute or
 *   ref never shows.
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
	RecordKey,
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

/**
 * `visible_threads(id)` among the threads `seed` names, each by its own
 * stored ancestry only: it shows when it has arrived and nothing on that walk
 * is deleted, the answer the whole-record read gives it. A one-thread read
 * costs that thread's depth instead of every thread's.
 */
const visibleAmong = (seed: string) => `
WITH RECURSIVE
  seed(id) AS (${seed}),
  chain(start, node) AS (
    SELECT id, id FROM seed
    UNION
    SELECT chain.start, t.parent_id FROM chain JOIN ${TABLES.threads} t ON t.id = chain.node
     WHERE t.parent_id IS NOT NULL
  ),
  visible_threads(id) AS (
    SELECT s.id FROM seed s JOIN ${TABLES.threads} t ON t.id = s.id
     WHERE NOT EXISTS (
       SELECT 1 FROM chain c JOIN ${TABLES.threads} a ON a.id = c.node
        WHERE c.start = s.id AND a.deleted_at IS NOT NULL)
  )`;

/**
 * What decides visibility for a read: the whole record's, or, for one thread,
 * that thread's alone, with the filter on the read's own column.
 */
const scopeOf = (column: string, threadId: string | undefined) =>
	threadId === undefined
		? { visible: VISIBLE_THREADS_SQL, where: "", params: [] as string[] }
		: {
				visible: visibleAmong("SELECT ?"),
				where: `AND ${column} = ?`,
				params: [threadId, threadId],
			};

const PREFIX = RecordKey.THREAD_URI_PREFIX;
/** True when ref `r` points at no thread. */
const NOT_A_LINK = `substr(r.uri, 1, ${PREFIX.length}) <> '${PREFIX}'`;
/** The thread ref `r` points at (meaningful only when it is a link). */
const TARGET = `substr(r.uri, ${PREFIX.length + 1})`;
/** The threads links point at, for a seed; a caller narrows it with `AND`. */
const TARGETS = `SELECT substr(uri, ${PREFIX.length + 1}) FROM ${TABLES.refs}
  WHERE substr(uri, 1, ${PREFIX.length}) = '${PREFIX}'`;

export namespace RecordRead {
	/** Whether thread `id` shows: arrived, and nothing on its stored ancestry deleted. */
	export const isVisible = (db: Db, id: string): boolean =>
		db
			.query<{ id: string }, [string]>(
				`${visibleAmong("SELECT ?")} SELECT id FROM visible_threads`,
			)
			.get(id) !== null;

	/**
	 * The `visible_threads(id)` clause for the threads `seed` names, each by its
	 * own ancestry: a read of a few threads that must not walk the whole record.
	 */
	export const visibleAmongSql = visibleAmong;

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
		const { visible, where, params } = scopeOf("e.thread_id", threadId);
		return rowsOf(EntryRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${visible}
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
		const { visible, where, params } = scopeOf("a.thread_id", threadId);
		return rowsOf(AttributeRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${visible}
					 SELECT a.* FROM ${TABLES.attributes} a
					   JOIN visible_threads v ON v.id = a.thread_id
					  WHERE a.removed_at IS NULL ${where}
					  ORDER BY a.thread_id, a.key`,
				)
				.all(...params),
		);
	};

	/**
	 * Refs on visible threads. A ref to a thread (`kabane://thread/<id>`, a
	 * link) shows only while that thread shows too.
	 */
	export const refs = (db: Db, threadId?: string): Result<RefRow[]> => {
		const visible =
			threadId === undefined
				? VISIBLE_THREADS_SQL
				: visibleAmong(`SELECT ? UNION ${TARGETS} AND thread_id = ?`);
		const params = threadId === undefined ? [] : [threadId, threadId, threadId];
		return rowsOf(RefRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${visible}
					 SELECT r.* FROM ${TABLES.refs} r
					   JOIN visible_threads v ON v.id = r.thread_id
					  WHERE r.removed_at IS NULL
					    AND (${NOT_A_LINK} OR ${TARGET} IN (SELECT id FROM visible_threads))
					    ${threadId === undefined ? "" : "AND r.thread_id = ?"}
					  ORDER BY r.thread_id, r.uri, r.kind`,
				)
				.all(...params),
		);
	};

	/**
	 * Links: refs from one thread to another, both of which show. Given a
	 * thread, its links either way: what it points at, and what points at it
	 * (an indexed lookup on the ref's URI).
	 */
	export const links = (db: Db, threadId?: string): Result<RefRow[]> => {
		const scoped = threadId !== undefined;
		const visible = scoped
			? visibleAmong(
					`SELECT ? UNION ${TARGETS} AND thread_id = ?
					 UNION SELECT thread_id FROM ${TABLES.refs} WHERE uri = ?`,
				)
			: VISIBLE_THREADS_SQL;
		const uri = scoped ? RecordKey.threadUri(threadId) : "";
		const params = scoped ? [threadId, threadId, uri, threadId, uri] : [];
		return rowsOf(RefRowSchema, () =>
			db
				.query<unknown, string[]>(
					`${visible}
					 SELECT r.* FROM ${TABLES.refs} r
					   JOIN visible_threads s ON s.id = r.thread_id
					   JOIN visible_threads t ON t.id = ${TARGET}
					  WHERE r.removed_at IS NULL AND NOT ${NOT_A_LINK}
					    ${scoped ? "AND (r.thread_id = ? OR r.uri = ?)" : ""}
					  ORDER BY r.thread_id, r.uri, r.kind`,
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
				.query<unknown, [string, string]>(
					`${visibleAmong("SELECT ?")}
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
				.all(threadId, threadId),
		);
		return held.ok ? ok(held.value[0]) : held;
	};
}
