/**
 * Planner Storage — an issue's timeline of entries.
 *
 * The table keeps its name, `task_comments`, because rows and synced logs
 * store it. A comment is an entry of kind `comment`, and the comment functions
 * read and write that kind only.
 */

import { err, type Result } from "../result";
import { Runtime, withDb } from "../runtime";

import {
	DEFAULT_ENTRY_KIND,
	ENTRY_KIND_PATTERN,
	type TaskComment,
	type TaskCommentDraft,
	type TaskCommentUpdate,
	type TaskEntry,
	type TaskEntryDraft,
} from "../schemas";
import { generateId, rowToEntry, TABLES } from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	/**
	 * Append an entry to a task's timeline. The kind is checked for its shape
	 * only: a kind no module declares is stored like any other, and the body is
	 * never parsed.
	 */
	export const addEntry = async (
		basePath: string,
		draft: TaskEntryDraft,
	): Promise<Result<TaskEntry>> => {
		if (!ENTRY_KIND_PATTERN.test(draft.kind))
			return err(
				new Error(
					`Entry kind "${draft.kind}" is not valid: use lowercase letters, digits and dashes, as "name" or "name.key" (e.g. "review", "handoff.summary").`,
				),
			);
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.comments}
           (id, task_id, kind, author, author_type, content, updated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.taskId,
					draft.kind,
					draft.author,
					draft.authorType,
					draft.content,
					Runtime.actor(),
					now,
				],
			);
			Oplog.afterWrite(db, "task_comments", "insert", id);

			return {
				id,
				taskId: draft.taskId,
				kind: draft.kind,
				author: draft.author,
				authorType: draft.authorType,
				content: draft.content,
				createdAt: now,
				updatedAt: undefined,
			};
		});
	};

	/** A task's entries in time order, only those of `kind` when it is given. */
	export const getEntries = async (
		basePath: string,
		taskId: string,
		{ kind }: { kind?: string } = {},
	): Promise<Result<TaskEntry[]>> => {
		return withDb(basePath, (db) => {
			const rows = (
				kind === undefined
					? db
							.query(
								`SELECT * FROM ${TABLES.comments} WHERE task_id = ?
								  ORDER BY created_at ASC, id ASC`,
							)
							.all(taskId)
					: db
							.query(
								`SELECT * FROM ${TABLES.comments} WHERE task_id = ? AND kind = ?
								  ORDER BY created_at ASC, id ASC`,
							)
							.all(taskId, kind)
			) as Record<string, unknown>[];

			return rows.map(rowToEntry);
		});
	};

	/** A task's newest entry of `kind`, or null when it has none. */
	export const latestEntry = async (
		basePath: string,
		taskId: string,
		kind: string,
	): Promise<Result<TaskEntry | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(
					`SELECT * FROM ${TABLES.comments} WHERE task_id = ? AND kind = ?
					  ORDER BY created_at DESC, id DESC LIMIT 1`,
				)
				.get(taskId, kind) as Record<string, unknown> | null;

			return row ? rowToEntry(row) : null;
		});
	};

	/** Add a comment: an entry of the default kind. */
	export const addComment = async (
		basePath: string,
		draft: TaskCommentDraft,
	): Promise<Result<TaskComment>> =>
		addEntry(basePath, { ...draft, kind: DEFAULT_ENTRY_KIND });

	export const getComment = async (
		basePath: string,
		id: string,
	): Promise<Result<TaskComment | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.comments} WHERE id = ?`)
				.get(id) as Record<string, unknown> | null;

			return row ? rowToEntry(row) : null;
		});
	};

	export const updateComment = async (
		basePath: string,
		id: string,
		updates: TaskCommentUpdate,
	): Promise<Result<TaskComment | null>> => {
		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			db.run(
				`UPDATE ${TABLES.comments}
            SET content = ?, updated_at = ?, version = version + 1, updated_by = ?
          WHERE id = ?`,
				[updates.content, now, Runtime.actor(), id],
			);
			Oplog.afterWrite(db, "task_comments", "update", id);
		});

		if (!updateResult.ok) return updateResult;

		return getComment(basePath, id);
	};

	/** A task's comments: its entries of the default kind, in time order. */
	export const getComments = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskComment[]>> =>
		getEntries(basePath, taskId, { kind: DEFAULT_ENTRY_KIND });

	export const deleteComment = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			const row = Oplog.snapshot(db, "task_comments", id);
			if (!row.ok) throw row.error;
			db.run(`DELETE FROM ${TABLES.comments} WHERE id = ?`, [id]);
			if (row.value !== undefined) {
				Oplog.afterDelete(db, [{ tbl: "task_comments", row: row.value }]);
			}
		});
	};
}
