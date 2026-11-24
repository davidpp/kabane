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
import type { Db } from "../db/port";
import { err, ok, quoted, type Result } from "../result";
import { atomic, withDb } from "../runtime";

import { Modules } from "../module";
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

/** Why `kind` is no kind a caller may write, or undefined when it is one. */
const kindProblem = (kind: string): string | undefined => {
	if (kind === WORK_LOG_KIND)
		return `Entry kind ${quoted(kind)} is the work log's: record work with kabane_log.`;
	if (CORE_ENTRY_KINDS.includes(kind))
		return `Entry kind ${quoted(kind)} is the claim's: set the task in_progress, or put it back, with kabane_edit.`;
	if (!ENTRY_KIND_PATTERN.test(kind))
		return `Entry kind ${quoted(kind)} is not valid: use lowercase letters, digits and dashes, as "name" or "name.key" (e.g. "review", "handoff.summary").`;
	return undefined;
};

export namespace Planner {
	/**
	 * Append an entry in the caller's transaction, for a module whose write
	 * spans more than the entry: addressed to actors (`to`), replying to an
	 * entry (`re`), its kind's fields in `data`. Returns its id. Throws on a
	 * kind no caller may write, so the transaction rolls back.
	 */
	export const addEntryIn = (
		db: Db,
		draft: {
			taskId: string;
			kind: string;
			author: string;
			body: string | null;
			to?: readonly string[];
			re?: string;
			data?: Record<string, unknown>;
			createdAt?: string;
			/** Private whatever its thread is, as a reply to a private entry must be. */
			private?: boolean;
		},
	): string => {
		const problem = kindProblem(draft.kind);
		if (problem !== undefined) throw new Error(problem);
		const id = entryId();
		RecordWrite.addEntry(db, {
			id,
			threadId: draft.taskId,
			kind: draft.kind,
			author: draft.author,
			body: draft.body,
			data: draft.data ?? null,
			createdAt: draft.createdAt ?? new Date().toISOString(),
			to: draft.to,
			re: draft.re,
			private: draft.private,
		});
		return id;
	};

	/**
	 * Append an entry to a task's timeline. The kind is checked for its shape
	 * only: a kind no module declares is stored like any other, and the body is
	 * never parsed.
	 */
	export const addEntry = async (
		basePath: string,
		draft: TaskEntryDraft,
	): Promise<Result<TaskEntry>> => {
		const problem = kindProblem(draft.kind);
		if (problem !== undefined) return err(new Error(problem));
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
	 * given. The work log's and the claim's entries are never among them, nor
	 * a kind its module declares with projection `none`: that module shows
	 * those entries itself.
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
						Modules.kind(row.kind)?.projection !== "none" &&
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
