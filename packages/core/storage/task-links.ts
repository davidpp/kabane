/**
 * Planner Storage — Task Links
 */

import type { Result } from "../result";
import { withDb } from "../runtime";

import type { TaskLink, TaskLinkDraft } from "../schemas";
import { generateId, rowToLink, TABLES } from "./helpers";

export namespace Planner {
	export const addLink = async (
		basePath: string,
		draft: TaskLinkDraft,
	): Promise<Result<TaskLink>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.task_links} (id, source_id, target_id, type, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.sourceId,
					draft.targetId,
					draft.type,
					draft.note ?? null,
					now,
				],
			);

			return {
				id,
				sourceId: draft.sourceId,
				targetId: draft.targetId,
				type: draft.type,
				note: draft.note,
				createdAt: now,
			};
		});
	};

	export const getLinksForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskLink[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.task_links} WHERE source_id = ? OR target_id = ?`,
				)
				.all(taskId, taskId) as Record<string, unknown>[];

			return rows.map(rowToLink);
		});
	};

	export const deleteLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			db.run(`DELETE FROM ${TABLES.task_links} WHERE id = ?`, [id]);
		});
	};
}
