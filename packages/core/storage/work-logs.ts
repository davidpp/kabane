/**
 * Planner Storage — Work Logs
 *
 * A work log row is an entry of kind `log` on the thread, its refs in `data`
 * (migration 14). Append-only, like every entry.
 */

import { monotonicFactory } from "ulid";
import type { Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type { AddWorkLogInput, TaskWorkLog, WorkRef } from "../schemas";
import { rowToWorkLog } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

/** The entry kind a work log is stored under. */
export const WORK_LOG_KIND = "log";

/**
 * Rising within this process, as entry ids do: a work log reads in time order,
 * then id, so two written in one millisecond keep their order.
 */
const workLogId = monotonicFactory();

export namespace Planner {
	export const addWorkLog = async (
		basePath: string,
		input: AddWorkLogInput,
	): Promise<Result<TaskWorkLog>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = workLogId();

			const refs: WorkRef[] = input.refs.map((r) => ({
				uri: r.uri,
				label: r.label,
				addedAt: now,
				addedBy: input.addedBy,
				addedByType: input.addedByType,
			}));

			RecordWrite.addEntry(db, {
				id,
				threadId: input.taskId,
				kind: WORK_LOG_KIND,
				author: Runtime.actor(),
				body: input.note ?? null,
				data: { refs },
				createdAt: now,
			});

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
			const rows = RecordRead.entries(db, taskId);
			if (!rows.ok) throw rows.error;
			return rows.value
				.filter((row) => row.kind === WORK_LOG_KIND)
				.map(rowToWorkLog);
		});
	};
}
