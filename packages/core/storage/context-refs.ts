/**
 * Planner Storage — Context Refs
 *
 * A curated registry of input context refs per task (the *input* side of an
 * issue), distinct from the append-only work log. Re-promoting the same
 * (task_id, uri) upserts kind/label/note/added_at.
 */

import type { Db } from "../db/port";
import { NotFoundError, type Result } from "../result";
import { atomic, withDb } from "../runtime";

import {
	type AddContextRefInput,
	RecordKey,
	type RefRow,
	type TaskContextRef,
} from "../schemas";
import { RESERVED_REF_KINDS, refFamily } from "./families";
import { rowToContextRef } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";
import { Planner as PlannerWorkLogs } from "./work-logs";

/** A context ref is a ref of the context family (`families.ts`). */
const isContextRef = (row: RefRow): boolean => refFamily(row) === "context";

/** The old id a migrated ref keeps in `data.id`, when it has one. */
const oldIdOf = (row: RefRow): unknown =>
	row.data === null ? undefined : (JSON.parse(row.data) as { id?: unknown }).id;

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
	export const addContextRefIn = (
		db: Db,
		input: AddContextRefInput,
	): TaskContextRef => {
		if (
			refFamily(input) !== "context" ||
			RESERVED_REF_KINDS.includes(input.kind)
		)
			throw new Error(
				`A context ref takes no thread URI and no link or upstream kind (${input.kind} ${input.uri}): link threads with kabane_link, issues with kabane_upstream_link.`,
			);
		const now = new Date().toISOString();
		let oldId: unknown;
		for (const held of contextRefsOf(db, input.taskId))
			if (held.uri === input.uri && held.kind !== input.kind) {
				oldId ??= oldIdOf(held);
				RecordWrite.removeRef(
					db,
					RecordKey.rowIdOf("refs", held) ?? "",
					"context",
				);
			}
		RecordWrite.putRef(db, {
			threadId: input.taskId,
			uri: input.uri,
			kind: input.kind,
			title: input.label ?? null,
			data: {
				...(oldId === undefined ? {} : { id: oldId }),
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
	};

	export const addContextRef = async (
		basePath: string,
		input: AddContextRefInput,
	): Promise<Result<TaskContextRef>> =>
		atomic(basePath, (db) => addContextRefIn(db, input));

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

	/**
	 * Remove the context ref `id` names: its row id (`RecordKey`) or the old id
	 * a migrated one keeps. An error when no context ref by that id is live.
	 */
	export const deleteContextRef = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return atomic(basePath, (db) => {
			if (!RecordWrite.removeRef(db, id, "context"))
				throw new NotFoundError(`No context ref ${id}`);
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
		// The work-log entry and the registry row land together, or neither.
		return atomic(basePath, (db) => {
			PlannerWorkLogs.addWorkLogIn(db, {
				taskId: input.taskId,
				refs: [{ uri: input.uri, label: input.label }],
				note: input.note,
				addedBy: input.addedBy,
				addedByType: input.addedByType,
			});
			return addContextRefIn(db, {
				taskId: input.taskId,
				uri: input.uri,
				kind: input.kind,
				label: input.label,
				note: input.note,
				addedBy: input.addedBy,
				addedByType: input.addedByType,
			});
		});
	};
}
