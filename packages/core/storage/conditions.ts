import { TABLES } from "../db/tables";
import { Modules } from "../module";
import { err, map, NotFoundError, ok, type Result } from "../result";
import { withDb } from "../runtime";
import { RecordRead } from "./record";

/** An entry addressed to someone that no reply has closed. */
type OpenAddressed = { id: string; taskId: string; kind: string };
import type { TaskState } from "../schemas";
import { Planner as Links } from "./task-links";
import { Planner as Tasks } from "./tasks";

const requireTask = async (basePath: string, id: string) => {
	const task = await Tasks.getTask(basePath, id);
	if (!task.ok) return task;
	return task.value
		? ok(task.value)
		: err(new NotFoundError(`No task found: ${id}`));
};

export namespace Planner {
	/**
	 * Every entry addressed to `actor` (its `to`) that no reply (`re`) has
	 * closed, oldest first, on threads that show. Which replies close an entry
	 * is its kind's declaration (`closedBy`); a kind that declares none is
	 * closed by any reply.
	 */
	export const addressed = async (
		basePath: string,
		actor: string,
	): Promise<Result<OpenAddressed[]>> =>
		withDb(basePath, (db) =>
			db
				.query<
					{ id: string; thread_id: string; kind: string; replies: string },
					[string]
				>(
					`${RecordRead.visibleAmongSql(
						`SELECT DISTINCT thread_id FROM ${TABLES.entries} WHERE addressed_to IS NOT NULL`,
					)}
					 SELECT e.id, e.thread_id, e.kind,
					        (SELECT json_group_array(r.kind) FROM ${TABLES.entries} r
					          WHERE r.thread_id = e.thread_id AND r.re = e.id) AS replies
					   FROM ${TABLES.entries} e
					   JOIN visible_threads v ON v.id = e.thread_id
					  WHERE e.addressed_to IS NOT NULL
					    AND EXISTS (SELECT 1 FROM json_each(e.addressed_to) a WHERE a.value = ?)
					  ORDER BY e.created_at, e.id`,
				)
				.all(actor)
				.filter((row) => {
					const replies = JSON.parse(row.replies) as string[];
					const closedBy = Modules.kind(row.kind)?.closedBy;
					return !replies.some(
						(kind) => closedBy === undefined || closedBy.includes(kind),
					);
				})
				.map((row) => ({ id: row.id, taskId: row.thread_id, kind: row.kind })),
		);

	/** The actor who holds thread `id`'s claim (`RecordRead.claimHolder`), or null. */
	export const claimHolder = async (
		basePath: string,
		id: string,
	): Promise<Result<string | null>> =>
		withDb(basePath, (db) => {
			const held = RecordRead.claimHolder(db, id);
			if (!held.ok) throw held.error;
			return held.value?.author ?? null;
		});

	export const matchingState = async (
		basePath: string,
		id: string,
		states: readonly TaskState[],
	): Promise<Result<TaskState | null>> =>
		map(await requireTask(basePath, id), ({ state }) =>
			state !== undefined && states.includes(state) ? state : null,
		);

	export const isReady = async (
		basePath: string,
		id: string,
	): Promise<Result<boolean>> => {
		const task = await requireTask(basePath, id);
		if (!task.ok) return task;
		const taskId = task.value.id;
		const links = await Links.getLinksForTask(basePath, taskId);
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
		return map(await Tasks.getTasks(basePath, [...ids]), (blockers) =>
			blockers.every(({ state }) => state === "done" || state === "cancelled"),
		);
	};
}
