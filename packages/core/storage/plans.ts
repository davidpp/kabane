/**
 * Planner Storage — applying a plan file (ADR 0006).
 *
 * A plan names its threads by keys. Applied under a plan key, each thread's id
 * is `<plan key>/<thread key>` (`KEYED_ID_PATTERN`), so a second apply of the
 * same plan finds every thread and link in place and writes nothing. The
 * whole plan lands in one transaction: a crash leaves none of it, and a retry
 * files it whole.
 */

import { Events, PLANNER_EVENTS } from "../events";
import { err, ok, quoted, type Result } from "../result";
import { atomic } from "../runtime";
import {
	KEY_PATTERN,
	type Plan,
	PlanSchema,
	type Task,
	type TaskDraft,
	type TaskSource,
} from "../schemas";
import { derivePrefix, normalizeOptionalScopeUri } from "./helpers";
import { Planner as Links } from "./task-links";
import { existingKeyed, Planner as Tasks, taskOf } from "./tasks";

type AppliedPlan = {
	key: string;
	threads: { key: string; id: string; shortId?: string; created: boolean }[];
	links: { created: number; existing: number };
};

export namespace Planner {
	/**
	 * File `plan` under `key`. A link or parent names its end by a key in the
	 * plan, or by an existing task's id or label. A thread with no scope takes
	 * `scopeUri`. Every thread and link reads as `created` or already there.
	 */
	export const applyPlan = async (
		basePath: string,
		input: Plan,
		{
			key,
			scopeUri,
			author,
			source,
		}: {
			key: string;
			scopeUri?: string;
			author: string;
			source: TaskSource;
		},
	): Promise<Result<AppliedPlan>> => {
		if (!KEY_PATTERN.test(key))
			return err(
				new Error(
					`Plan key ${quoted(key)} is not a key: use lowercase letters, digits, dots, dashes and underscores.`,
				),
			);
		const parsed = PlanSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid plan: ${parsed.error.message}`));
		const plan = parsed.data;
		const idOf = new Map(
			plan.threads.map((thread) => [thread.key, `${key}/${thread.key}`]),
		);

		// Ends outside the plan resolve before the write, as kabane_link's do.
		const ends = new Map<string, string>();
		for (const end of [
			...plan.threads.flatMap((thread) => thread.parent ?? []),
			...plan.links.flatMap((link) => [link.from, link.to]),
		]) {
			if (idOf.has(end) || ends.has(end)) continue;
			const id = await Tasks.resolveTaskId(basePath, end);
			if (!id.ok) return id;
			ends.set(end, id.value);
		}
		const endOf = (end: string): string =>
			idOf.get(end) ?? (ends.get(end) as string);

		const scoped: {
			thread: (typeof plan.threads)[number];
			scope: string | undefined;
			prefix: string;
		}[] = [];
		for (const thread of plan.threads) {
			const scope = normalizeOptionalScopeUri(thread.scopeUri ?? scopeUri);
			if (!scope.ok) return scope;
			const prefix = derivePrefix(scope.value);
			if (!prefix.ok) return prefix;
			scoped.push({ thread, scope: scope.value, prefix: prefix.value });
		}

		const now = new Date().toISOString();
		const written = await atomic(basePath, (db) => {
			const created: Task[] = [];
			const threads: AppliedPlan["threads"] = [];
			for (const { thread, scope, prefix } of scoped) {
				const id = idOf.get(thread.key) as string;
				if (existingKeyed(db, id)) {
					const held = taskOf(db, id);
					threads.push({
						key: thread.key,
						id,
						shortId: held.shortId,
						created: false,
					});
					continue;
				}
				const draft: TaskDraft = {
					title: thread.title,
					description: thread.description,
					kind: thread.kind ?? "issue",
					state: thread.state ?? "inbox",
					priority: thread.priority ?? "normal",
					assignee: thread.assignee,
					tags: thread.tags ?? [],
					parentTaskId:
						thread.parent === undefined ? undefined : endOf(thread.parent),
					provenance: { source, discoveredAt: now, discoveredBy: author },
				};
				const task = Tasks.createTaskIn(db, draft, scope, prefix, id);
				created.push(task);
				threads.push({
					key: thread.key,
					id,
					shortId: task.shortId,
					created: true,
				});
			}
			const links = { created: 0, existing: 0 };
			for (const link of plan.links) {
				const draft = {
					sourceId: endOf(link.from),
					targetId: endOf(link.to),
					type: link.type,
					note: link.note,
				};
				if (Links.linkHeld(db, draft)) {
					links.existing++;
					continue;
				}
				Links.addLinkIn(db, draft);
				links.created++;
			}
			return { created, applied: { key, threads, links } };
		});
		if (!written.ok) return written;
		for (const task of written.value.created)
			await Events.emit(PLANNER_EVENTS.TASK_CREATED, task);
		return ok(written.value.applied);
	};
}
