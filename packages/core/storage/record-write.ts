/**
 * Local writes to the 2.0 record (ADR 0006), each captured.
 *
 * A write stamps the register it changes: a clock no lower than the one
 * stored (UTC, `toISOString`), a counter one past the stored one, and this
 * device's id (empty before sync is armed). That is what lets every device
 * order two writes the same way (`sync/resolve.ts`, "The 2.0 record"). A
 * thread's text, its claim and its delete are separate registers, so a write
 * touches only the one it changes; an attribute and a ref are one each, and an
 * entry is written once.
 *
 * Attributes, refs and entries copy their thread's `visibility`: a private
 * thread's rows stay out of the log with it.
 */

import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { Runtime } from "../runtime";
import { RecordKey } from "../schemas";
import { Oplog } from "./oplog";

type Value = string | number | null;

const deviceOf = (db: Db): string => {
	const state = Oplog.getState(db);
	if (!state.ok) throw state.error;
	return state.value?.deviceId ?? "";
};

/** Now (or `at`), or the stored clock when it is ahead of that. */
const clockAfter = (
	stored: string | null | undefined,
	at = new Date().toISOString(),
): string => (stored != null && stored > at ? stored : at);

const visibilityOf = (db: Db, threadId: string): string =>
	db
		.query<{ visibility: string }, [string]>(
			`SELECT visibility FROM ${TABLES.threads} WHERE id = ?`,
		)
		.get(threadId)?.visibility ?? "shared";

type ThreadDraft = {
	id: string;
	shortId: string | null;
	kind: string;
	title: string;
	body: string | null;
	scope: string | null;
	parentId: string | null;
	createdBy: string | null;
	state: string | null;
	assignee: string | null;
	now: string;
};

/** The text register's columns a write may set. */
export type ThreadText = Partial<{
	short_id: string | null;
	kind: string;
	title: string;
	body: string | null;
	scope: string | null;
	parent_id: string | null;
}>;

/** The claim register's columns a write may set. */
export type ThreadClaim = Partial<{
	state: string | null;
	assignee: string | null;
}>;

const setClause = (values: Record<string, Value>) =>
	Object.keys(values)
		.map((column) => `"${column}" = ?`)
		.join(", ");

export namespace RecordWrite {
	export const createThread = (db: Db, draft: ThreadDraft): void => {
		const device = deviceOf(db);
		const actor = Runtime.actor();
		db.run(
			`INSERT INTO ${TABLES.threads}
			   (id, short_id, kind, title, body, scope, parent_id, created_by, created_at,
			    updated_at, updated_by, updated_device, version,
			    state, assignee, state_updated_at, state_updated_by, state_updated_device, state_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1)`,
			[
				draft.id,
				draft.shortId,
				draft.kind,
				draft.title,
				draft.body,
				draft.scope,
				draft.parentId,
				draft.createdBy,
				draft.now,
				draft.now,
				actor,
				device,
				draft.state,
				draft.assignee,
				draft.now,
				actor,
				device,
			],
		);
		Oplog.afterWrite(db, TABLES.threads, "insert", draft.id);
	};

	/** Write the thread's text register. Nothing to write is no write. */
	export const updateText = (db: Db, id: string, text: ThreadText): void => {
		if (Object.keys(text).length === 0) return;
		const stored = db
			.query<{ updated_at: string }, [string]>(
				`SELECT updated_at FROM ${TABLES.threads} WHERE id = ?`,
			)
			.get(id);
		if (!stored) return;
		const values = text as Record<string, Value>;
		db.run(
			`UPDATE ${TABLES.threads}
			    SET ${setClause(values)}, updated_at = ?, updated_by = ?,
			        updated_device = ?, version = version + 1
			  WHERE id = ?`,
			[
				...Object.values(values),
				clockAfter(stored.updated_at),
				Runtime.actor(),
				deviceOf(db),
				id,
			],
		);
		Oplog.afterWrite(db, TABLES.threads, "update", id);
	};

	/** Write the thread's claim register. Nothing to write is no write. */
	export const updateClaim = (db: Db, id: string, claim: ThreadClaim): void => {
		if (Object.keys(claim).length === 0) return;
		const stored = db
			.query<{ state_updated_at: string }, [string]>(
				`SELECT state_updated_at FROM ${TABLES.threads} WHERE id = ?`,
			)
			.get(id);
		if (!stored) return;
		const values = claim as Record<string, Value>;
		db.run(
			`UPDATE ${TABLES.threads}
			    SET ${setClause(values)}, state_updated_at = ?, state_updated_by = ?,
			        state_updated_device = ?, state_version = state_version + 1
			  WHERE id = ?`,
			[
				...Object.values(values),
				clockAfter(stored.state_updated_at),
				Runtime.actor(),
				deviceOf(db),
				id,
			],
		);
		Oplog.afterWrite(db, TABLES.threads, "update", id);
	};

	/** A delete is final: the thread and everything under it read as gone. */
	export const deleteThread = (db: Db, id: string): void => {
		db.run(
			`UPDATE ${TABLES.threads} SET deleted_at = ?, deleted_device = ?
			  WHERE id = ? AND deleted_at IS NULL`,
			[clockAfter(undefined), deviceOf(db), id],
		);
		Oplog.afterWrite(db, TABLES.threads, "update", id);
	};

	/**
	 * Set attribute `key` on a thread, or remove it with `null`. Setting the
	 * value it already holds writes nothing. `at` is the write's clock when the
	 * caller has one, as a new thread's attributes share its creation time.
	 */
	export const setAttribute = (
		db: Db,
		threadId: string,
		key: string,
		value: Value,
		at?: string,
	): void => {
		const text = value === null ? null : String(value);
		const stored = db
			.query<
				{ value: string | null; removed_at: string | null; updated_at: string },
				[string, string]
			>(
				`SELECT value, removed_at, updated_at FROM ${TABLES.attributes}
				  WHERE thread_id = ? AND key = ?`,
			)
			.get(threadId, key);
		const live = stored != null && stored.removed_at === null;
		if (text === null ? !live : live && stored.value === text) return;
		const clock = clockAfter(stored?.updated_at, at);
		db.run(
			`INSERT INTO ${TABLES.attributes}
			   (thread_id, key, value, removed_at, visibility, updated_at, updated_by, updated_device, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
			 ON CONFLICT(thread_id, key) DO UPDATE SET
			   value = excluded.value, removed_at = excluded.removed_at,
			   updated_at = excluded.updated_at, updated_by = excluded.updated_by,
			   updated_device = excluded.updated_device, version = version + 1`,
			[
				threadId,
				key,
				text ?? stored?.value ?? null,
				text === null ? clock : null,
				visibilityOf(db, threadId),
				clock,
				Runtime.actor(),
				deviceOf(db),
			],
		);
		Oplog.afterWrite(
			db,
			TABLES.attributes,
			stored ? "update" : "insert",
			JSON.stringify([threadId, key]),
		);
	};

	/** Make or remake a ref; its `title` and `data` are the latest write's. */
	export const putRef = (
		db: Db,
		ref: {
			threadId: string;
			uri: string;
			kind: string;
			title: string | null;
			data: Record<string, unknown> | null;
		},
	): void => {
		const stored = db
			.query<{ updated_at: string }, [string, string, string]>(
				`SELECT updated_at FROM ${TABLES.refs} WHERE thread_id = ? AND uri = ? AND kind = ?`,
			)
			.get(ref.threadId, ref.uri, ref.kind);
		db.run(
			`INSERT INTO ${TABLES.refs}
			   (thread_id, uri, kind, title, data, removed_at, visibility,
			    updated_at, updated_by, updated_device, version)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1)
			 ON CONFLICT(thread_id, uri, kind) DO UPDATE SET
			   title = excluded.title, data = excluded.data, removed_at = NULL,
			   updated_at = excluded.updated_at, updated_by = excluded.updated_by,
			   updated_device = excluded.updated_device, version = version + 1`,
			[
				ref.threadId,
				ref.uri,
				ref.kind,
				ref.title,
				ref.data === null ? null : JSON.stringify(ref.data),
				visibilityOf(db, ref.threadId),
				clockAfter(stored?.updated_at),
				Runtime.actor(),
				deviceOf(db),
			],
		);
		Oplog.afterWrite(
			db,
			TABLES.refs,
			stored ? "update" : "insert",
			JSON.stringify([ref.threadId, ref.uri, ref.kind]),
		);
	};

	/** Remove the ref a row id names (`RecordKey`); false when none is live. */
	export const removeRef = (db: Db, rowId: string): boolean => {
		const parts = RecordKey.partsOf("refs", rowId);
		if (parts === undefined) return false;
		const stored = db
			.query<{ updated_at: string }, string[]>(
				`SELECT updated_at FROM ${TABLES.refs}
				  WHERE thread_id = ? AND uri = ? AND kind = ? AND removed_at IS NULL`,
			)
			.get(...parts);
		if (!stored) return false;
		const clock = clockAfter(stored.updated_at);
		db.run(
			`UPDATE ${TABLES.refs}
			    SET removed_at = ?, updated_at = ?, updated_by = ?, updated_device = ?,
			        version = version + 1
			  WHERE thread_id = ? AND uri = ? AND kind = ?`,
			[clock, clock, Runtime.actor(), deviceOf(db), ...parts],
		);
		Oplog.afterWrite(db, TABLES.refs, "update", rowId);
		return true;
	};

	export const addEntry = (
		db: Db,
		entry: {
			id: string;
			threadId: string;
			kind: string;
			author: string;
			body: string | null;
			data: Record<string, unknown> | null;
			createdAt: string;
		},
	): void => {
		db.run(
			`INSERT INTO ${TABLES.entries}
			   (id, thread_id, kind, author, body, data, visibility, created_at,
			    updated_by, created_device, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			[
				entry.id,
				entry.threadId,
				entry.kind,
				entry.author,
				entry.body,
				entry.data === null ? null : JSON.stringify(entry.data),
				visibilityOf(db, entry.threadId),
				entry.createdAt,
				Runtime.actor(),
				deviceOf(db),
			],
		);
		Oplog.afterWrite(db, TABLES.entries, "insert", entry.id);
	};
}
