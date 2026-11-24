/**
 * Planner Storage — Task Links
 */

import { err, ok, NotFoundError, type Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type { TaskLink, TaskLinkDraft, TaskState } from "../schemas";
import { generateId, rowToLink, TABLES } from "./helpers";
import { Oplog } from "./oplog";

import { Planner as Tasks } from "./tasks";

export namespace Planner {
	export const taskCondition = async (
		basePath: string,
		id: string,
		condition: "ready" | readonly TaskState[],
	): Promise<
		Result<{
			taskId: string;
			condition: "ready" | "state";
			state?: TaskState;
		} | null>
	> => {
		const task = await Tasks.getTask(basePath, id);
		if (!task.ok) return task;
		if (!task.value) return err(new NotFoundError(`No task found: ${id}`));
		const taskId = task.value.id;
		if (condition !== "ready") {
			const { state } = task.value;
			return ok(
				condition.includes(state)
					? { condition: "state", taskId, state }
					: null,
			);
		}
		const links = await getLinksForTask(basePath, taskId);
		if (!links.ok) return links;
		const ids = new Set<string>();
		for (const link of links.value) {
			if (link.type === "blocks" && link.targetId === taskId)
				ids.add(link.sourceId);
			if (
				(link.type === "blocked_by" || link.type === "follows") &&
				link.sourceId === taskId
			)
				ids.add(link.targetId);
		}
		const blockers = await Tasks.getTasks(basePath, [...ids]);
		if (!blockers.ok) return blockers;
		const ready =
			blockers.value.length === ids.size &&
			blockers.value.every(
				({ state }) => state === "done" || state === "cancelled",
			);
		return ok(ready ? { condition: "ready", taskId } : null);
	};

	export const addLink = async (
		basePath: string,
		draft: TaskLinkDraft,
	): Promise<Result<TaskLink>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			db.run(
				`INSERT INTO ${TABLES.task_links}
           (id, source_id, target_id, type, note, updated_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.sourceId,
					draft.targetId,
					draft.type,
					draft.note ?? null,
					Runtime.actor(),
					now,
				],
			);
			Oplog.afterWrite(db, "task_links", "insert", id);

			return {
				id,
				sourceId: draft.sourceId,
				targetId: draft.targetId,
				type: draft.type,
				note: draft.note,
				createdAt: now,
			};
		});
	};

	export const getLinksForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<TaskLink[]>> => {
		return withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT * FROM ${TABLES.task_links} WHERE source_id = ? OR target_id = ?`,
				)
				.all(taskId, taskId) as Record<string, unknown>[];

			return rows.map(rowToLink);
		});
	};

	export const deleteLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			const row = Oplog.snapshot(db, "task_links", id);
			if (!row.ok) throw row.error;
			db.run(`DELETE FROM ${TABLES.task_links} WHERE id = ?`, [id]);
			if (row.value !== undefined) {
				Oplog.afterDelete(db, [{ tbl: "task_links", row: row.value }]);
			}
		});
	};
}
