// The jobs extension: `kabane run`, `kabane runs` and `kabane job`, its settings, its doctor
// checks (hc, the user-level `job` skill, and what ticks the jobs), and on
// the board a card per run that names an issue, `a` offering the recipes that work on one (and
// running a job now), and the facts of every job for the Jobs tab.
import { homedir } from "node:os";
import type { Extension, Host } from "@kabane/extension";
import { RecipeActivity } from "./activity";
import { RecipeDispatcher } from "./dispatcher";
import { entries, jobCommand } from "./job-command";
import { JobSkill } from "./job-skill";
import { RecipeJobs } from "./job-source";
import { JobTick } from "./job-tick";
import { jobsHost } from "./jobs-host";
import { Kabane, ok } from "./result";
import { runCommand, settingsSchema } from "./run-command";
import { runsCommand } from "./runs-command";
import { HcRuntime } from "./runtime-hc";

export const jobs = (given: Host): Extension => {
	Kabane.bind(given);
	const host = jobsHost(given);
	const settings = settingsSchema(host.z);
	const runtime = HcRuntime.runtime(host.z);
	return {
		name: "jobs",
		settings,
		commands: [
			runCommand(host, settings, runtime),
			runsCommand(host, runtime),
			jobCommand(host, settings, runtime),
		],
		// Ports for the board's project, the folder it was opened in; jobs are every scope's.
		board: async (ctx) => {
			const project = () => host.scope.detect(ctx.cwd);
			return {
				activity: RecipeActivity.source({
					host,
					runtime,
					project,
					actor: ctx.actor,
				}),
				dispatcher: RecipeDispatcher.make({
					host,
					runtime,
					project,
					settings,
					ctx,
				}),
				jobs: RecipeJobs.source({
					host,
					runtime,
					settings,
					actor: ctx.actor,
				}),
			};
		},
		doctor: async (ctx) => {
			const missing = runtime.missing();
			// Without the store (doctor could not open it) the jobs are unknown: no tick finding.
			const listed = await entries(host);
			return ok([
				...(missing === undefined
					? []
					: [
							{
								id: "hc-missing",
								severity: "mention" as const,
								summary: missing,
							},
						]),
				...JobSkill.check(),
				...(listed.ok
					? JobTick.check(
							listed.value.length,
							JobTick.targetOf(host, ctx.home),
							{
								platform: JobTick.platformOf(process.platform),
								home: homedir(),
							},
						)
					: []),
			]);
		},
	};
};
