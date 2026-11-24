/**
 * Planner Storage — Task Links
 *
 * A link is a ref of the link family from its source thread to
 * `kabane://thread/<target>`, the link type as its kind (migration 14). Its id
 * is the ref's row id (`RecordKey`). `parent` and `child` are no link: they
 * set the child's parent, and deleting by the id adding one returned clears it
 * again while it still names that parent.
 */

import { NotFoundError, type Result } from "../result";
import { atomic, withDb } from "../runtime";

import { RecordKey, type TaskLink, type TaskLinkDraft } from "../schemas";
import { refFamily } from "./families";
import { rowToLink, TABLES } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

const FOLDED = ["parent", "child"];

/** The child and parent a `parent` or `child` link names. */
const fold = (source: string, target: string, type: string) =>
	type === "parent"
		? { child: target, parent: source }
		: { child: source, parent: target };

export namespace Planner {
	export const addLink = async (
		basePath: string,
		draft: TaskLinkDraft,
	): Promise<Result<TaskLink>> => {
		return atomic(basePath, (db) => {
			const now = new Date().toISOString();
			const uri = RecordKey.threadUri(draft.targetId);
			for (const id of [draft.sourceId, draft.targetId])
				if (!RecordRead.isVisible(db, id))
					throw new NotFoundError(`No task found with ID: ${id}`);
			if (FOLDED.includes(draft.type)) {
				const { child, parent } = fold(
					draft.sourceId,
					draft.targetId,
					draft.type,
				);
				RecordWrite.updateText(db, child, { parent_id: parent });
			} else {
				RecordWrite.putRef(db, {
					threadId: draft.sourceId,
					uri,
					kind: draft.type,
					title: null,
					data: {
						family: "link",
						...(draft.note === undefined ? {} : { note: draft.note }),
						created_at: now,
					},
				});
			}

			return {
				id: JSON.stringify([draft.sourceId, uri, draft.type]),
				sourceId: draft.sourceId,
				targetId: draft.targetId,
				type: draft.type,
				note: draft.note,
				createdAt: now,
			};
		});
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
			const [source, uri, type] = RecordKey.partsOf("refs", id) ?? [];
			if (
				source !== undefined &&
				uri !== undefined &&
				type !== undefined &&
				FOLDED.includes(type)
			) {
				const { child, parent } = fold(
					source,
					uri.slice(RecordKey.THREAD_URI_PREFIX.length),
					type,
				);
				const held = db
					.query<{ parent_id: string | null }, [string]>(
						`SELECT parent_id FROM ${TABLES.threads} WHERE id = ?`,
					)
					.get(child);
				if (held?.parent_id !== parent)
					throw new NotFoundError(`No ${type} link ${id}`);
				RecordWrite.updateText(db, child, { parent_id: null });
				return;
			}
			if (!RecordWrite.removeRef(db, id, "link"))
				throw new NotFoundError(`No link ${id}`);
		});
	};
}
