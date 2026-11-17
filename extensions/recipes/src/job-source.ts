// The board's Jobs tab, as data: for the job ids the board lists from the tracker, every scope's,
// what `kabane job show` prints, and its newest runs with the command that attaches to each. The
// board draws it and never runs `hc`: a run's session opens in a terminal, through that command.
import type { JobFacts, JobSource } from "@cabane/extension";
import { type Deps, runsOf, SHOWN_RUNS } from "./job-command";
import { Jobs } from "./jobs";
import { ok } from "./result";

export namespace RecipeJobs {
	const attach = (id: string): string => `kabane runs attach ${id}`;

	export const source = (d: Deps & { actor: string }): JobSource => ({
		facts: async (jobIds) => {
			const wanted = new Set(jobIds);
			const jobs = await Jobs.all(d.host);
			if (!jobs.ok) return jobs;
			const roots = await Jobs.roots(d.host);
			if (!roots.ok) return roots;
			const facts: Record<string, JobFacts> = {};
			for (const job of jobs.value) {
				if (!wanted.has(job.taskId)) continue;
				const task = await d.host.record.get({ id: job.taskId });
				if (!task.ok) return task;
				if (task.value === null) continue;
				const runs = await runsOf(d, { job, task: task.value }, d.actor);
				if (!runs.ok) return runs;
				const next = Jobs.next(job);
				const folder = roots.value.get(task.value.scopeUri ?? "");
				facts[job.taskId] = {
					schedule: job.schedule,
					...(next.ok
						? { next: next.value.toISOString() }
						: { problem: next.error.message }),
					recipe: job.recipe,
					inputs: job.inputs,
					...(job.harness ? { harness: job.harness } : {}),
					session: job.session,
					...(folder === undefined ? {} : { folder }),
					runs: runs.value.slice(0, SHOWN_RUNS).map((run) => ({
						id: run.id,
						state: run.state,
						startedAt: run.startedAt,
						open: attach(run.id),
					})),
				};
			}
			return ok(facts);
		},
	});
}
