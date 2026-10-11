// The runner's in-process state, and the two writes every step goes through: an event on the
// trace and a run.json save. A save replaces `ctx.run` and writes it before the step goes on,
// which is what lets a run resume after its runner dies.
import type { Harnesses } from "@cabane/acp";
import type { Dispatch } from "./dispatch";
import type { Gates } from "./gates";
import { RunStore } from "./store";
import type { Worktree } from "./worktree";

export namespace RunState {
	export type Deps = {
		/** KABANE_HOME: where `loops/` lives. */
		home: string;
		/** The core base path (the database's directory). */
		basePath: string;
		/** The `kabane` executable each session's MCP server runs as. */
		kabaneBin: string;
		/** This process's pid, recorded so readers can tell a live run from an orphaned one. */
		pid: number;
		/** Launch overrides per harness (a local adapter build, a model). */
		overrides?: Partial<Record<Harnesses.Id, Harnesses.Overrides>>;
		/** Aborting it stops the run the way an inbox `stop` does. */
		signal?: AbortSignal;
		/** A fingerprint of the working tree, for the stall detector and the gates. Defaults to git. */
		tree?: (cwd: string) => string;
		/** How checkpoints run git. Defaults to the user's own git and config. */
		git?: Worktree.Git;
		now?: () => Date;
		tickMs?: number;
	};

	type Live = {
		/** The subtask it works on, or the parent for a lens. */
		taskId: string;
		handle: Dispatch.Handle;
		/** Resolves once the session has ended and its gates, if any, have run. */
		settled: Promise<void>;
	};

	export type Settled = {
		taskId: string;
		sessionId: string;
		outcome: Dispatch.Outcome;
		/** The gates its end ran: a session that closed its subtask, in a run with gates. */
		gates?: Gates.Run;
	};

	export type Ctx = {
		deps: Deps;
		now: () => Date;
		tree: (cwd: string) => string;
		log: RunStore.EventLog;
		run: RunStore.Run;
		/** Live claims by core session id. */
		live: Map<string, Live>;
		/** Claims whose session ended and that the loop has not settled yet. */
		settled: Settled[];
		/** Ends the runner's current wait early. */
		wake: () => void;
		stopRequested: boolean;
		/** Aborted when the run halts: kills a gate still running. */
		stopping: AbortController;
	};

	/** The tasks live claims hold: what the frontier leaves out. */
	export const liveTasks = (ctx: Ctx): Set<string> =>
		new Set([...ctx.live.values()].map((l) => l.taskId));

	export const event = (ctx: Ctx, draft: RunStore.EventDraft): void => {
		const appended = ctx.log.append(draft);
		if (!appended.ok)
			console.error(
				`loop ${ctx.run.id}: event lost: ${appended.error.message}`,
			);
	};

	export const save = (ctx: Ctx, next: RunStore.Run): void => {
		ctx.run = next;
		const written = RunStore.write(ctx.deps.home, next);
		if (!written.ok)
			console.error(
				`loop ${next.id}: run.json not written: ${written.error.message}`,
			);
	};

	export const patchClaim = (
		ctx: Ctx,
		sessionId: string,
		patch: Partial<RunStore.Claim>,
	): void =>
		save(ctx, {
			...ctx.run,
			claims: ctx.run.claims.map((c) =>
				c.sessionId === sessionId ? { ...c, ...patch } : c,
			),
		});
}
