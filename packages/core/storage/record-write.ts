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
import { NotFoundError } from "../result";
import { Runtime } from "../runtime";
import { RecordKey } from "../schemas";
import { REF_FAMILY_SQL, type RefFamily } from "./families";
import { Oplog } from "./oplog";
import { RecordRead } from "./record";

type Value = string | number | null;

const deviceOf = (db: Db): string => {
	const state = Oplog.getState(db);
	if (!state.ok) throw state.error;
	return state.value?.deviceId ?? "";
};

/**
 * A clock past every register the `Task` read takes its audit from: the
 * thread's text and claim and each of its attributes. A local edit then reads
 * as the latest write even when a stored clock is ahead of this device's.
 */
const taskClock = (db: Db, threadId: string): string => {
	const latest = db
		.query<{ at: string | null }, [string, string]>(
			`SELECT MAX(t.updated_at, t.state_updated_at,
			            COALESCE((SELECT MAX(a.updated_at) FROM ${TABLES.attributes} a
			                       WHERE a.thread_id = ?), '')) AS at
			   FROM ${TABLES.threads} t WHERE t.id = ?`,
		)
		.get(threadId, threadId)?.at;
	const now = new Date().toISOString();
	if (latest == null || latest < now) return now;
	return new Date(Date.parse(latest) + 1).toISOString();
};

/** Now (or `at`), or the stored clock when it is ahead of that. */
const clockAfter = (
	stored: string | null | undefined,
	at = new Date().toISOString(),
): string => (stored != null && stored > at ? stored : at);

/**
 * The visibility of a thread a local write may add to: one that shows. Sync
 * apply never comes through here, so a row may still arrive before its thread.
 */
const visibilityOf = (db: Db, threadId: string): string => {
	const row = db
		.query<{ visibility: string }, [string]>(
			`SELECT visibility FROM ${TABLES.threads} WHERE id = ?`,
		)
		.get(threadId);
	if (row === null || !RecordRead.isVisible(db, threadId))
		throw new NotFoundError(`No task found with ID: ${threadId}`);
	return row.visibility;
};

/** The keys a ref's earlier writes left in its `data` that a rewrite keeps. */
const KEPT_REF_DATA = ["id"] as const;

const keptData = (
	stored: string | null | undefined,
): Record<string, unknown> => {
	if (stored == null) return {};
	const parsed: unknown = JSON.parse(stored);
	if (typeof parsed !== "object" || parsed === null) return {};
	const held = parsed as Record<string, unknown>;
	return Object.fromEntries(
		KEPT_REF_DATA.filter((key) => held[key] !== undefined).map((key) => [
			key,
			held[key],
		]),
	);
};

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
				taskClock(db, id),
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
				taskClock(db, id),
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
	 * value it already holds writes nothing. `created` is the clock of a thread
	 * written in the same step: the attribute takes it, and its counter starts
	 * at 0, so it is no write of its own.
	 */
	export const setAttribute = (
		db: Db,
		threadId: string,
		key: string,
		value: Value,
		created?: string,
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
		const visibility = visibilityOf(db, threadId);
		const clock =
			created === undefined
				? taskClock(db, threadId)
				: clockAfter(stored?.updated_at, created);
		db.run(
			`INSERT INTO ${TABLES.attributes}
			   (thread_id, key, value, removed_at, visibility, updated_at, updated_by, updated_device, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(thread_id, key) DO UPDATE SET
			   value = excluded.value, removed_at = excluded.removed_at,
			   updated_at = excluded.updated_at, updated_by = excluded.updated_by,
			   updated_device = excluded.updated_device, version = version + 1`,
			[
				threadId,
				key,
				text ?? stored?.value ?? null,
				text === null ? clock : null,
				visibility,
				clock,
				Runtime.actor(),
				deviceOf(db),
				created === undefined ? 1 : 0,
			],
		);
		Oplog.afterWrite(
			db,
			TABLES.attributes,
			stored ? "update" : "insert",
			JSON.stringify([threadId, key]),
		);
	};

	/**
	 * Make or remake a ref; its `title` and `data` are the latest write's, but
	 * for the old id a migrated ref keeps in `data`.
	 */
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
		const visibility = visibilityOf(db, ref.threadId);
		const stored = db
			.query<
				{ updated_at: string; data: string | null },
				[string, string, string]
			>(
				`SELECT updated_at, data FROM ${TABLES.refs} WHERE thread_id = ? AND uri = ? AND kind = ?`,
			)
			.get(ref.threadId, ref.uri, ref.kind);
		const data =
			ref.data === null ? null : { ...ref.data, ...keptData(stored?.data) };
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
				data === null ? null : JSON.stringify(data),
				visibility,
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

	/**
	 * Remove the live ref of `family` that `id` names: its row id
	 * (`RecordKey`), or the old id a migrated ref keeps in `data.id`. False when
	 * no such ref is live.
	 */
	export const removeRef = (db: Db, id: string, family: RefFamily): boolean => {
		const parts = RecordKey.partsOf("refs", id);
		const stored = db
			.query<
				{ thread_id: string; uri: string; kind: string; updated_at: string },
				string[]
			>(
				`SELECT r.thread_id, r.uri, r.kind, r.updated_at FROM ${TABLES.refs} r
				  WHERE r.removed_at IS NULL AND ${REF_FAMILY_SQL} = ?
				    AND ${parts === undefined ? "json_extract(r.data, '$.id') = ?" : "r.thread_id = ? AND r.uri = ? AND r.kind = ?"}`,
			)
			.get(family, ...(parts ?? [id]));
		if (!stored) return false;
		const clock = clockAfter(stored.updated_at);
		const key = [stored.thread_id, stored.uri, stored.kind];
		db.run(
			`UPDATE ${TABLES.refs}
			    SET removed_at = ?, updated_at = ?, updated_by = ?, updated_device = ?,
			        version = version + 1
			  WHERE thread_id = ? AND uri = ? AND kind = ?`,
			[clock, clock, Runtime.actor(), deviceOf(db), ...key],
		);
		Oplog.afterWrite(db, TABLES.refs, "update", JSON.stringify(key));
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
