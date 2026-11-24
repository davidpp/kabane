/**
 * Planner Storage — Task Links
 *
 * A link is a ref from its source thread to `kabane://thread/<target>`, the
 * link type as its kind (migration 14). Its id is the ref's row id
 * (`RecordKey`). `parent` and `child` are no link: they set the child's parent.
 */

import { type Result } from "../result";
import { withDb } from "../runtime";

import { RecordKey, type TaskLink, type TaskLinkDraft } from "../schemas";
import { rowToLink } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

export namespace Planner {
	export const addLink = async (
		basePath: string,
		draft: TaskLinkDraft,
	): Promise<Result<TaskLink>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const uri = RecordKey.threadUri(draft.targetId);
			if (draft.type === "parent" || draft.type === "child") {
				const [child, parent] =
					draft.type === "parent"
						? [draft.targetId, draft.sourceId]
						: [draft.sourceId, draft.targetId];
				RecordWrite.updateText(db, child, { parent_id: parent });
			} else {
				RecordWrite.putRef(db, {
					threadId: draft.sourceId,
					uri,
					kind: draft.type,
					title: null,
					data:
						draft.note === undefined
							? { created_at: now }
							: { note: draft.note, created_at: now },
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
			return rows.value.map(rowToLink);
		});
	};

	export const deleteLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			RecordWrite.removeRef(db, id);
		});
	};
}
