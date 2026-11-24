/**
 * Planner Storage — Work Logs
 *
 * A work log row is an entry of kind `log` on the thread, its refs in `data`
 * (migration 14); no other entry takes that kind. Append-only, like every
 * entry.
 */

import { monotonicFactory } from "ulid";
import type { Db } from "../db/port";
import { err, type Result } from "../result";
import { atomic, Runtime, withDb } from "../runtime";

import type { AddWorkLogInput, TaskWorkLog, WorkRef } from "../schemas";
import { isWorkLog, WORK_LOG_KIND } from "./families";
import { rowToWorkLog } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

/**
 * Rising within this process, as entry ids do: a work log reads in time order,
 * then id, so two written in one millisecond keep their order.
 */
const workLogId = monotonicFactory();

export namespace Planner {
	/** Append a work log inside the caller's transaction. */
	export const addWorkLogIn = (db: Db, input: AddWorkLogInput): TaskWorkLog => {
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
	};

	export const addWorkLog = async (
		basePath: string,
		input: AddWorkLogInput,
	): Promise<Result<TaskWorkLog>> =>
		atomic(basePath, (db) => addWorkLogIn(db, input));

	export const getWorkLogs = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskWorkLog[]>> => {
		return withDb(basePath, (db) => {
			const rows = RecordRead.entries(db, taskId);
			if (!rows.ok) throw rows.error;
			return rows.value.filter(isWorkLog).map(rowToWorkLog);
		});
	};

	/** Entries are append-only: a work log is never deleted. */
	export const deleteWorkLog = async (
		_basePath: string,
		id: string,
	): Promise<Result<void>> =>
		err(
			new Error(
				`Work log ${id} stays: the work log is append-only since migration 14, like every timeline entry.`,
			),
		);
}
