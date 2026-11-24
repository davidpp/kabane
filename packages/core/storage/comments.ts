/**
 * Planner Storage — an issue's timeline of entries.
 *
 * Entries live in the record's `entries` table (migration 14). A comment is an
 * entry of kind `comment`, and the comment functions read and write that kind
 * only; a work log is an entry of kind `log` (`work-logs.ts`), a kind the
 * timeline neither takes nor shows. Entries are append-only: nothing here edits or deletes
 * one. A deleted task's entries read as gone with it (`RecordRead`).
 */

import { monotonicFactory } from "ulid";
import { err, ok, quoted, type Result } from "../result";
import { atomic, withDb } from "../runtime";

import {
	DEFAULT_ENTRY_KIND,
	ENTRY_KIND_PATTERN,
	type TaskComment,
	type TaskCommentDraft,
	type TaskEntry,
	type TaskEntryDraft,
} from "../schemas";
import { CORE_ENTRY_KINDS, WORK_LOG_KIND } from "./families";
import { rowToEntry } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

/**
 * Entry ids rise strictly within this process, even inside one millisecond,
 * so two entries written in the same millisecond keep their order: time order
 * is `created_at`, then `id`. Writers in two processes (two devices, two CLI
 * runs) can still tie on `created_at`, and then the id decides arbitrarily.
 */
const entryId = monotonicFactory();

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
		if (draft.kind === WORK_LOG_KIND)
			return err(
				new Error(
					`Entry kind ${quoted(draft.kind)} is the work log's: record work with kabane_log.`,
				),
			);
		if (CORE_ENTRY_KINDS.includes(draft.kind))
			return err(
				new Error(
					`Entry kind ${quoted(draft.kind)} is the claim's: set the task in_progress, or put it back, with kabane_edit.`,
				),
			);
		if (!ENTRY_KIND_PATTERN.test(draft.kind))
			return err(
				new Error(
					`Entry kind ${quoted(draft.kind)} is not valid: use lowercase letters, digits and dashes, as "name" or "name.key" (e.g. "review", "handoff.summary").`,
				),
			);
		return atomic(basePath, (db) => {
			const now = new Date().toISOString();
			const id = entryId();

			RecordWrite.addEntry(db, {
				id,
				threadId: draft.taskId,
				kind: draft.kind,
				author: draft.author,
				body: draft.content,
				data: { author_type: draft.authorType },
				createdAt: now,
			});

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

	/**
	 * A task's timeline in time order, only the entries of `kind` when it is
	 * given. The work log's and the claim's entries are never among them.
	 */
	export const getEntries = async (
		basePath: string,
		taskId: string,
		{ kind }: { kind?: string } = {},
	): Promise<Result<TaskEntry[]>> => {
		return withDb(basePath, (db) => {
			const rows = RecordRead.entries(db, taskId);
			if (!rows.ok) throw rows.error;
			return rows.value
				.filter(
					(row) =>
						!CORE_ENTRY_KINDS.includes(row.kind) &&
						(kind === undefined || row.kind === kind),
				)
				.map(rowToEntry);
		});
	};

	/**
	 * A task's newest entry of `kind`, or null when it has none: the latest
	 * `created_at`, and of two in one millisecond the higher id, which is the
	 * later write when both came from one process (`entryId`).
	 */
	export const latestEntry = async (
		basePath: string,
		taskId: string,
		kind: string,
	): Promise<Result<TaskEntry | null>> => {
		const entries = await getEntries(basePath, taskId, { kind });
		return entries.ok ? ok(entries.value.at(-1) ?? null) : entries;
	};

	/** Add a comment: an entry of the default kind. */
	export const addComment = async (
		basePath: string,
		draft: TaskCommentDraft,
	): Promise<Result<TaskComment>> =>
		addEntry(basePath, { ...draft, kind: DEFAULT_ENTRY_KIND });

	/** A task's comments: its entries of the default kind, in time order. */
	export const getComments = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskComment[]>> =>
		getEntries(basePath, taskId, { kind: DEFAULT_ENTRY_KIND });
}
