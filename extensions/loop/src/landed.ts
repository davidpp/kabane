// The user's `onLanded` command: run once a completed run's branch has landed, by the runner or by
// `kabane loop land`, with what landed in its environment. What follows a landing (a push, GitHub's
// auto-merge, `kabane loop prune`, a message) is the user's to compose; the loop builds none of it.
// It runs once the run is over, so a `kabane loop prune` it starts sees the run as done with: the
// run is written completed and nothing holds its worktree's lock. Its end is an event on the
// run's trace and nothing else: a command that fails leaves the run completed and its landing ok.
import { Exec } from "./exec";
import { Gates } from "./gates";
import type { Land } from "./land";
import { RunState } from "./state";
import { RunStore } from "./store";

export namespace Landed {
	// What the command is told of the landing, as environment variables.
	const env = (run: RunStore.Run, mode: Land.Mode): Record<string, string> => ({
		KABANE_RUN_ID: run.id,
		KABANE_PARENT: run.parentShortId,
		KABANE_LAND: mode,
		KABANE_BRANCH: RunStore.branchOf(run),
		// A run made from a detached HEAD has no base branch; its commit is the base then.
		...(run.base ? { KABANE_BASE: run.base.branch ?? run.base.sha } : {}),
		...(run.worktree ? { KABANE_WORKTREE: run.worktree } : {}),
		...(run.pr ? { KABANE_PR: run.pr } : {}),
		...(run.landing?.merged ? { KABANE_MERGED: run.landing.merged } : {}),
	});

	/**
	 * Run the run's `onLanded` command in its project's checkout, when one is set, the run is
	 * completed and its last landing, made as `mode`, is ok. Nothing a stop asks for reaches it but
	 * the runner's own `signal`: a run that ends stopped never gets here.
	 */
	export const hook = async (
		ctx: RunState.Ctx,
		mode: Land.Mode,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> => {
		const { run } = ctx;
		const command = run.config.onLanded;
		if (
			command === undefined ||
			run.status !== "completed" ||
			run.landing?.ok !== true
		)
			return;
		const [ran] = await Gates.run(
			{ onLanded: command },
			run.projectDir,
			env(run, mode),
			signal,
		);
		if (ran === undefined) return;
		const tail = Exec.redact(ran.tail.trim());
		RunState.event(ctx, {
			type: ran.ok ? "on_landed" : "warning",
			summary: `${Gates.describe(ran)}: \`${Exec.redact(command)}\`${tail ? `\n${tail}` : ""}`,
			data: {
				command: Exec.redact(command),
				...(ran.exit === null ? {} : { exit: ran.exit }),
			},
		});
	};
}
