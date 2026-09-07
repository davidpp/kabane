/**
 * Planner Storage — Comments
 */

import type { Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type {
	TaskComment,
	TaskCommentDraft,
	TaskCommentUpdate,
} from "../schemas";
import { generateId, rowToComment, TABLES } from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	export const addComment = async (
		basePath: string,
		draft: TaskCommentDraft,
	): Promise<Result<TaskComment>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.comments}
           (id, task_id, author, author_type, content, updated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.taskId,
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
				author: draft.author,
				authorType: draft.authorType,
				content: draft.content,
				createdAt: now,
				updatedAt: undefined,
			};
		});
	};

	export const getComment = async (
		basePath: string,
		id: string,
	): Promise<Result<TaskComment | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.comments} WHERE id = ?`)
				.get(id) as Record<string, unknown> | null;

			return row ? rowToComment(row) : null;
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

	export const getComments = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskComment[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.comments} WHERE task_id = ? ORDER BY created_at ASC`,
				)
				.all(taskId) as Record<string, unknown>[];

			return rows.map(rowToComment);
		});
	};

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
