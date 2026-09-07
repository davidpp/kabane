/**
 * Planner Storage — Work Logs
 */

import type { Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type { AddWorkLogInput, TaskWorkLog, WorkRef } from "../schemas";
import { generateId, rowToWorkLog, TABLES } from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	export const addWorkLog = async (
		basePath: string,
		input: AddWorkLogInput,
	): Promise<Result<TaskWorkLog>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			// Build refs with timestamps
			const refs: WorkRef[] = input.refs.map((r) => ({
				uri: r.uri,
				label: r.label,
				addedAt: now,
				addedBy: input.addedBy,
				addedByType: input.addedByType,
			}));

			db.run(
				`INSERT INTO ${TABLES.work_log} (id, task_id, refs, note, updated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.taskId,
					JSON.stringify(refs),
					input.note ?? null,
					Runtime.actor(),
					now,
				],
			);
			Oplog.afterWrite(db, "task_work_log", "insert", id);

			return {
				id,
				taskId: input.taskId,
				refs,
				note: input.note,
				createdAt: now,
			};
		});
	};

	export const getWorkLogs = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskWorkLog[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.work_log} WHERE task_id = ? ORDER BY created_at ASC`,
				)
				.all(taskId) as Record<string, unknown>[];

			return rows.map(rowToWorkLog);
		});
	};

	export const deleteWorkLog = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			const row = Oplog.snapshot(db, "task_work_log", id);
			if (!row.ok) throw row.error;
			db.run(`DELETE FROM ${TABLES.work_log} WHERE id = ?`, [id]);
			if (row.value !== undefined) {
				Oplog.afterDelete(db, [{ tbl: "task_work_log", row: row.value }]);
			}
		});
	};
}
