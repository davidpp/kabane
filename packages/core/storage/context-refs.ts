/**
 * Planner Storage — Context Refs
 *
 * A curated registry of input context refs per task (the *input* side of an
 * issue), distinct from the append-only work log. Re-promoting the same
 * (task_id, uri) upserts kind/label/note/added_at.
 */

import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb } from "../runtime";

import {
	type AddContextRefInput,
	RecordKey,
	type RefRow,
	type TaskContextRef,
} from "../schemas";
import { rowToContextRef } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";
import { Planner as PlannerWorkLogs } from "./work-logs";

/** The kind an upstream ref carries (`upstream-links.ts`). */
export const UPSTREAM_KIND = "upstream";

/**
 * A context ref is any ref that is no link to a thread and no upstream ref:
 * the three share the record's `refs` table (migration 14).
 */
const isContextRef = (row: RefRow): boolean =>
	row.kind !== UPSTREAM_KIND &&
	!row.uri.startsWith(RecordKey.THREAD_URI_PREFIX);

const contextRefsOf = (db: Db, taskId: string): RefRow[] => {
	const rows = RecordRead.refs(db, taskId);
	if (!rows.ok) throw rows.error;
	return rows.value.filter(isContextRef);
};

export namespace Planner {
	/**
	 * Register a context ref. A task holds one per URI: re-adding the URI under
	 * another kind removes the ref it had.
	 */
	export const addContextRef = async (
		basePath: string,
		input: AddContextRefInput,
	): Promise<Result<TaskContextRef>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			for (const held of contextRefsOf(db, input.taskId))
				if (held.uri === input.uri && held.kind !== input.kind)
					RecordWrite.removeRef(db, RecordKey.rowIdOf("refs", held) ?? "");
			RecordWrite.putRef(db, {
				threadId: input.taskId,
				uri: input.uri,
				kind: input.kind,
				title: input.label ?? null,
				data: {
					note: input.note ?? null,
					added_by: input.addedBy ?? null,
					added_by_type: input.addedByType ?? null,
					added_at: now,
				},
			});
			const row = contextRefsOf(db, input.taskId).find(
				(ref) => ref.uri === input.uri && ref.kind === input.kind,
			);
			if (row === undefined)
				throw new Error(
					`context ref ${input.uri} on ${input.taskId} does not show`,
				);
			return rowToContextRef(row);
		});
	};

	export const getContextRefs = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskContextRef[]>> => {
		return withDb(basePath, (db) =>
			contextRefsOf(db, taskId)
				.map(rowToContextRef)
				.sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
		);
	};

	/** Remove the context ref `id` (its row id, `RecordKey`) names. */
	export const deleteContextRef = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			RecordWrite.removeRef(db, id);
		});
	};

	export const promoteToContext = async (
		basePath: string,
		input: {
			taskId: string;
			uri: string;
			kind: string;
			label?: string;
			note?: string;
			addedBy?: string;
			addedByType?: "human" | "ai";
		},
	): Promise<Result<TaskContextRef>> => {
		const logResult = await PlannerWorkLogs.addWorkLog(basePath, {
			taskId: input.taskId,
			refs: [{ uri: input.uri, label: input.label }],
			note: input.note,
			addedBy: input.addedBy,
			addedByType: input.addedByType,
		});
		if (!logResult.ok) return logResult;

		return addContextRef(basePath, {
			taskId: input.taskId,
			uri: input.uri,
			kind: input.kind,
			label: input.label,
			note: input.note,
			addedBy: input.addedBy,
			addedByType: input.addedByType,
		});
	};
}
