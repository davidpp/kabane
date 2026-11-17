// The Jobs tab's model: every open job on this device, whatever its scope, with what a host's
// JobSource says about it (schedule, next fire, recipe, harness, runs), as plain functions the tab's
// rows, keys and tests share. Without a source a job is its item alone: title, scope and state.
//
// A job is an item of kind `job` in core, so its detail is the tracker's detail view; only the
// schedule and the runs, which an issue has no equivalent of, are drawn by the tab (jobs-view.tsx).
import { ScopeUri, type Task } from "@cabane/core";
import type { JobFacts, JobRunState } from "@cabane/extension";

export namespace BoardJobs {
	export type Job = { task: Task; facts?: JobFacts };

	export type Jobs = {
		// Open jobs, by scope, oldest first within it.
		list: readonly Job[];
		// The row the keys act on; null with no jobs.
		selectedId: string | null;
	};

	export const NONE: Jobs = { list: [], selectedId: null };

	/** Paused is the item parked in someday; any other open state runs on its schedule. */
	export const paused = (task: Task): boolean => task.state === "someday";

	/**
	 * A scope's name as a human reads it: the last part of the folder its jobs run in on this
	 * machine (`second-brain`), which a source knows; else its id, or the URI when it does not parse.
	 */
	const scopeLabel = (
		scopeUri: string | undefined,
		jobs: readonly Job[],
	): string => {
		const folder = jobs.find((job) => job.facts?.folder)?.facts?.folder;
		const named = folder?.split("/").findLast((part) => part !== "");
		if (named) return named;
		if (!scopeUri) return "no scope";
		const parsed = ScopeUri.parse(scopeUri);
		return parsed.ok ? parsed.value.scopeId : scopeUri;
	};

	/** The state of the job's newest run, absent when it has none or no source describes it. */
	export const lastRun = (job: Job): JobRunState | undefined =>
		job.facts?.runs[0]?.state;

	/** A run waits on the human: the one thing the tab exists to surface. */
	const waiting = (job: Job): boolean => lastRun(job) === "waiting";

	/** How many jobs have a run waiting on the human, which the tab bar counts. */
	export const waitingCount = (jobs: Jobs): number =>
		jobs.list.filter(waiting).length;

	/** The jobs under one scope each, in the order the list holds them. */
	export const byScope = (
		list: readonly Job[],
	): { scope: string; jobs: Job[] }[] => {
		const groups = new Map<string, Job[]>();
		for (const job of list) {
			const uri = job.task.scopeUri ?? "";
			groups.set(uri, [...(groups.get(uri) ?? []), job]);
		}
		return [...groups].map(([uri, jobs]) => ({
			scope: scopeLabel(uri || undefined, jobs),
			jobs,
		}));
	};

	/** The rows in the order they are drawn: by scope, as `byScope` groups them. */
	const ordered = (list: readonly Job[]): Job[] =>
		byScope(list).flatMap((group) => group.jobs);

	/**
	 * The poll's jobs, keeping the selected row by id when it is still listed, else the first. The
	 * same value when nothing moved, so a poll re-renders nothing.
	 */
	export const withList = (jobs: Jobs, list: readonly Job[]): Jobs => {
		const rows = ordered(list);
		const selectedId = rows.some((job) => job.task.id === jobs.selectedId)
			? jobs.selectedId
			: (rows[0]?.task.id ?? null);
		const next = { list: rows, selectedId };
		return JSON.stringify(next) === JSON.stringify(jobs) ? jobs : next;
	};

	/** `j`/`k`: the next or previous row, stopping at either end. */
	export const move = (jobs: Jobs, delta: 1 | -1): Jobs => {
		const at = jobs.list.findIndex((job) => job.task.id === jobs.selectedId);
		const next =
			jobs.list[Math.max(0, Math.min(jobs.list.length - 1, at + delta))];
		return next ? { ...jobs, selectedId: next.task.id } : jobs;
	};

	export const selected = (jobs: Jobs): Job | undefined =>
		jobs.list.find((job) => job.task.id === jobs.selectedId);

	/** "in 5m", "in 3h", "in 2d": how far off a fire is, for a row. "due" once it is past. */
	export const untilLabel = (iso: string, now: number): string => {
		const minutes = Math.round((Date.parse(iso) - now) / 60_000);
		if (minutes <= 0) return "due";
		if (minutes < 60) return `in ${minutes}m`;
		const hours = Math.round(minutes / 60);
		if (hours < 48) return `in ${hours}h`;
		return `in ${Math.round(hours / 24)}d`;
	};

	/** "11-18 09:00", in this machine's time zone, as the schedule is read. */
	export const whenLabel = (iso: string): string => {
		const date = new Date(iso);
		const two = (n: number) => String(n).padStart(2, "0");
		return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
	};

	/**
	 * What a row says after its title, most telling first, so a narrow pane drops from the end:
	 * a waiting run, paused, when it fires next, its schedule, recipe and harness. A job no source
	 * describes says only whether it is paused.
	 */
	export const meta = (job: Job, now: number): string[] => {
		const { facts } = job;
		const parts: string[] = [];
		if (waiting(job)) parts.push("? waiting");
		if (paused(job.task)) parts.push("paused");
		if (!facts) return parts;
		if (!paused(job.task))
			parts.push(facts.next ? untilLabel(facts.next, now) : "never fires");
		parts.push(facts.schedule, facts.recipe);
		if (facts.harness) parts.push(facts.harness[0] ?? "");
		return parts.filter((part) => part !== "");
	};

	/** The meta parts that fit in `room` columns, each after ` · `, dropped from the end. */
	export const fitMeta = (parts: readonly string[], room: number): string[] => {
		const kept: string[] = [];
		let used = 0;
		for (const part of parts) {
			const width = part.length + 3;
			if (used + width > room) break;
			kept.push(part);
			used += width;
		}
		return kept;
	};
}
