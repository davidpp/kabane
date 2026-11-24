/**
 * Planner Storage — Task Links
 *
 * A link is a ref of the link family from its source thread to
 * `kabane://thread/<target>`, the link type as its kind (migration 14). Its id
 * is the ref's row id (`RecordKey`). `parent` and `child` are no link: they
 * set the child's parent. Their id is `parent:["<child>","<parent>"]`, which no
 * ref key spells, and deleting by it clears the parent while it still names
 * that parent.
 */

import type { Db } from "../db/port";
import { NotFoundError, type Result } from "../result";
import { atomic, withDb } from "../runtime";

import { RecordKey, type TaskLink, type TaskLinkDraft } from "../schemas";
import { refFamily } from "./families";
import { rowToLink, TABLES } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

const FOLDED = ["parent", "child"];

const parentOf = (db: Db, child: string): string | null | undefined =>
	db
		.query<{ parent_id: string | null }, [string]>(
			`SELECT parent_id FROM ${TABLES.threads} WHERE id = ?`,
		)
		.get(child)?.parent_id;

const EDGE = "parent:";

/** The id of the parent edge a folded link set. */
const edgeId = (child: string, parent: string): string =>
	`${EDGE}${JSON.stringify([child, parent])}`;

/** The child and parent an edge id names, or undefined for any other id. */
const edgeOf = (id: string): { child: string; parent: string } | undefined => {
	if (!id.startsWith(EDGE)) return undefined;
	const [child, parent] =
		RecordKey.partsOf("attributes", id.slice(EDGE.length)) ?? [];
	return child === undefined || parent === undefined
		? undefined
		: { child, parent };
};

/** The child and parent a `parent` or `child` link names. */
const fold = (source: string, target: string, type: string) =>
	type === "parent"
		? { child: target, parent: source }
		: { child: source, parent: target };

export namespace Planner {
	export const addLink = async (
		basePath: string,
		draft: TaskLinkDraft,
	): Promise<Result<TaskLink>> =>
		atomic(basePath, (db) => addLinkIn(db, draft));

	/** Whether the link `draft` describes already stands: a live ref, or the parent it would set. */
	export const linkHeld = (db: Db, draft: TaskLinkDraft): boolean => {
		if (FOLDED.includes(draft.type)) {
			const { child, parent } = fold(
				draft.sourceId,
				draft.targetId,
				draft.type,
			);
			return parentOf(db, child) === parent;
		}
		return (
			db
				.query<{ live: number }, [string, string, string]>(
					`SELECT 1 AS live FROM ${TABLES.refs}
					  WHERE thread_id = ? AND uri = ? AND kind = ? AND removed_at IS NULL`,
				)
				.get(
					draft.sourceId,
					RecordKey.threadUri(draft.targetId),
					draft.type,
				) !== null
		);
	};

	/** Make a link in the caller's transaction. */
	export const addLinkIn = (db: Db, draft: TaskLinkDraft): TaskLink => {
		const now = new Date().toISOString();
		const uri = RecordKey.threadUri(draft.targetId);
		for (const id of [draft.sourceId, draft.targetId])
			if (!RecordRead.isVisible(db, id))
				throw new NotFoundError(`No task found with ID: ${id}`);
		let id = JSON.stringify([draft.sourceId, uri, draft.type]);
		if (FOLDED.includes(draft.type)) {
			const { child, parent } = fold(
				draft.sourceId,
				draft.targetId,
				draft.type,
			);
			RecordWrite.updateText(db, child, { parent_id: parent });
			id = edgeId(child, parent);
		} else {
			RecordWrite.putRef(db, {
				threadId: draft.sourceId,
				uri,
				kind: draft.type,
				title: null,
				data: {
					...(draft.note === undefined ? {} : { note: draft.note }),
					created_at: now,
				},
			});
		}

		return {
			id,
			sourceId: draft.sourceId,
			targetId: draft.targetId,
			type: draft.type,
			note: draft.note,
			createdAt: now,
		};
	};

	/** The task's links either way: what it points at and what points at it. */
	export const getLinksForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskLink[]>> => {
		return withDb(basePath, (db) => {
			const rows = RecordRead.links(db, taskId);
			if (!rows.ok) throw rows.error;
			return rows.value
				.filter((row) => refFamily(row) === "link")
				.map(rowToLink);
		});
	};

	/** Remove the link `id` names; a folded link clears the parent it set. */
	export const deleteLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return atomic(basePath, (db) => {
			const edge = edgeOf(id);
			if (edge !== undefined) {
				if (parentOf(db, edge.child) !== edge.parent)
					throw new NotFoundError(`No parent link ${id}`);
				RecordWrite.updateText(db, edge.child, { parent_id: null });
				return;
			}
			if (!RecordWrite.removeRef(db, id, "link"))
				throw new NotFoundError(`No link ${id}`);
		});
	};
}
