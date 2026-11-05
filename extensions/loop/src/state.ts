// The runner's in-process state, and the two writes every step goes through: an event on the
// trace and a run.json save. A save replaces `ctx.run` and writes it before the step goes on,
// which is what lets a run resume after its runner dies.
import type { Harnesses } from "@cabane/acp";
import type { Dispatch } from "./dispatch";
import type { Gates } from "./gates";
import type { Land } from "./land";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

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
		/** The mode every session starts in; the harness's own auto mode when absent. */
		mode?: Harnesses.Mode;
		/** Aborting it stops the run the way an inbox `stop` does. */
		signal?: AbortSignal;
		/** A fingerprint of the working tree, for the stall detector and the gates. Defaults to git. */
		tree?: (cwd: string) => Promise<string>;
		/** How checkpoints run git. Defaults to the user's own git and config. */
		git?: Worktree.Git;
		/** How landing reaches GitHub. Defaults to the user's own gh, signed in as they are. */
		gh?: Land.Gh;
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
		tree: (cwd: string) => Promise<string>;
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
		/** The gate pass running or last run; the next one waits for it. */
		gating: Promise<unknown>;
	};

	const git = async (cwd: string, args: string[]): Promise<string> => {
		const out = await Worktree.git(cwd, args);
		return out.ok ? out.value : "";
	};

	/** HEAD, the status and the diff, hashed: changes whenever an agent changes a file. */
	const gitTree = async (cwd: string): Promise<string> =>
		Bun.hash(
			(
				await Promise.all([
					git(cwd, ["rev-parse", "HEAD"]),
					git(cwd, ["status", "--porcelain"]),
					git(cwd, ["diff"]),
				])
			).join("\0"),
		).toString(36);

	/**
	 * What driving `run` in this process starts from, nothing live yet: the runner's, or a command's
	 * working on a run that is over (`kabane loop land`).
	 */
	export const make = (
		deps: Deps,
		run: RunStore.Run,
		log: RunStore.EventLog,
	): Ctx => ({
		deps,
		now: deps.now ?? (() => new Date()),
		tree: deps.tree ?? gitTree,
		log,
		run,
		live: new Map(),
		settled: [],
		wake: () => {},
		stopRequested: false,
		stopping: new AbortController(),
		gating: Promise.resolve(),
	});

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
