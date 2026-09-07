/**
 * Planner Storage — Task Timeline (combined view) + Digest (S5)
 */

import { ok, type Result } from "../result";
import type {
	AgentSession,
	SessionCard,
	TaskComment,
	TaskWorkLog,
} from "../schemas";
import { Planner as PlannerComments } from "./comments";
import { Planner as SelectDurable } from "./select-durable";
import { Planner as PlannerSessions } from "./sessions";
import { Planner as PlannerWorkLogs } from "./work-logs";

export namespace Planner {
	/**
	 * Timeline entry type discriminator.
	 *
	 * Agent sessions replaced the old planner_task_activity feed (S4a): session
	 * entries are anchored at their `startedAt`. The activity branch is gone —
	 * the physical table drop is S7's job.
	 *
	 * S5 fold: session entries keep `type:'session'` + `data:AgentSession` (so
	 * S4a's fallback consumers in dashboard/cli/loop are untouched) and gain an
	 * OPTIONAL `card` — populated when the timeline is folded (the default), so
	 * new surfaces render the collapsed card without breaking old ones.
	 */
	export type TimelineEntry =
		| { type: "comment"; data: TaskComment }
		| { type: "worklog"; data: TaskWorkLog }
		| { type: "session"; data: AgentSession; card?: SessionCard };

	/** Options for getTimeline. */
	export type TimelineOpts = {
		/** Attach a folded SessionCard to each session entry (default true). */
		fold?: boolean;
		/** Max entries to return (after sort). */
		limit?: number;
		/** Entries to skip before applying limit (default 0). */
		offset?: number;
	};

	/**
	 * Get combined timeline for a task (comments + work logs + agent sessions),
	 * sorted by timestamp ascending. Folded by default: each session entry gains
	 * a SessionCard. limit/offset paginate the sorted list; folding runs on the
	 * page only, so cards are built for returned sessions alone.
	 */
	export const getTimeline = async (
		basePath: string,
		taskId: string,
		opts: TimelineOpts = {},
	): Promise<Result<TimelineEntry[]>> => {
		const { fold = true, limit, offset = 0 } = opts;

		const [commentsResult, workLogsResult, sessionsResult] = await Promise.all([
			PlannerComments.getComments(basePath, taskId),
			PlannerWorkLogs.getWorkLogs(basePath, taskId),
			PlannerSessions.querySessions(basePath, { taskId }),
		]);

		if (!commentsResult.ok) return commentsResult;
		if (!workLogsResult.ok) return workLogsResult;
		if (!sessionsResult.ok) return sessionsResult;

		let timeline: TimelineEntry[] = [
			...commentsResult.value.map((c) => ({
				type: "comment" as const,
				data: c,
			})),
			...workLogsResult.value.map((w) => ({
				type: "worklog" as const,
				data: w,
			})),
			...sessionsResult.value.map((s) => ({
				type: "session" as const,
				data: s,
			})),
		];

		// Sort by timestamp (sessions anchor at startedAt).
		timeline.sort((a, b) => {
			const aTime = a.type === "session" ? a.data.startedAt : a.data.createdAt;
			const bTime = b.type === "session" ? b.data.startedAt : b.data.createdAt;
			return new Date(aTime).getTime() - new Date(bTime).getTime();
		});

		// Paginate the sorted list before folding, so cards are built for the page only.
		if (offset > 0 || limit !== undefined) {
			timeline = timeline.slice(
				offset,
				limit !== undefined ? offset + limit : undefined,
			);
		}

		if (!fold) return ok(timeline);

		// Fold: enrich each session entry with its card. A failed activity fetch
		// degrades to the bare session entry (never fails the whole timeline).
		const folded = await Promise.all(
			timeline.map(async (entry) => {
				if (entry.type !== "session") return entry;
				const activitiesResult = await PlannerSessions.getActivities(
					basePath,
					entry.data.id,
				);
				if (!activitiesResult.ok) return entry;
				return {
					...entry,
					card: SelectDurable.toSessionCard(entry.data, activitiesResult.value),
				};
			}),
		);

		return ok(folded);
	};

	/**
	 * Assemble a human-readable digest of a task's agent work: durable activities
	 * only (via selectDurableActivities — ephemera excluded), grouped by session,
	 * chronological. Sessions with no durable signal are skipped.
	 */
	export const assembleDigest = async (
		basePath: string,
		taskId: string,
	): Promise<Result<string>> => {
		const sessionsResult = await PlannerSessions.querySessions(basePath, {
			taskId,
		});
		if (!sessionsResult.ok) return sessionsResult;

		// querySessions is most-recently-active first; digest reads oldest-first.
		const ordered = [...sessionsResult.value].sort((a, b) =>
			a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
		);

		const blocks: string[] = [];
		for (const session of ordered) {
			const activitiesResult = await PlannerSessions.getActivities(
				basePath,
				session.id,
			);
			const activities = activitiesResult.ok ? activitiesResult.value : [];
			const durable = SelectDurable.selectDurableActivities(activities);
			if (durable.length === 0) continue;

			const header = `## ${session.agent} — ${session.state}`;
			const lines = durable.map((a) => {
				const tag = a.severity ? `${a.type}/${a.severity}` : a.type;
				return `- **[${tag}]** ${a.body.trim()}`;
			});
			blocks.push([header, ...lines].join("\n"));
		}

		if (blocks.length === 0) return ok("_No durable agent activity._");
		return ok(blocks.join("\n\n"));
	};
}
