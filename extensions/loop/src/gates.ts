// Gates: the project's own checks, named shell commands from the run's config, run in the
// directory the sessions work in. A run's gates are green when the latest time they ran every one
// passed and the working tree has not changed since; that is what the stop predicate asks.
//
// They run in order and stop at the first failure: what reopens the subtask is the first red gate,
// and the later ones would only spend time on a tree already known to be wrong.
import { tryCatch, trySync } from "@cabane/core";
import { z } from "zod";

export namespace Gates {
	const ResultSchema = z.object({
		name: z.string(),
		command: z.string(),
		ok: z.boolean(),
		/**
		 * The exit code; null when the run's stop killed the command, or it never started. Either
		 * way it says nothing about the work, so a null exit reopens nothing.
		 */
		exit: z.number().int().nullable(),
		ms: z.number().min(0),
		/** The end of what it printed, stdout and stderr together: what the next brief quotes. */
		tail: z.string(),
	});
	export type Result = z.infer<typeof ResultSchema>;

	/** One pass over the gates: after a subtask's session, or the run's own check before it ends. */
	export const RunSchema = z.object({
		at: z.string(),
		/** The subtask whose session's end ran it; absent for the run's own final check. */
		taskId: z.string().optional(),
		results: z.array(ResultSchema),
		ok: z.boolean(),
		/** The working tree's fingerprint once the pass and its checkpoint were done. */
		tree: z.string(),
		/** The checkpoint committed for a green pass, in a run with a worktree. */
		checkpoint: z.string().optional(),
	});
	export type Run = z.infer<typeof RunSchema>;

	const TAIL_LINES = 40;
	const TAIL_CHARS = 4_000;

	/** The last lines of `output`, bounded both ways. */
	const tail = (output: string): string =>
		output
			.trimEnd()
			.split("\n")
			.slice(-TAIL_LINES)
			.join("\n")
			.slice(-TAIL_CHARS);

	// How long a stopped gate's processes get to exit on SIGTERM before they are killed outright.
	const KILL_GRACE_MS = 1_000;

	// The gate leads a process group of its own, so a signal reaches everything it started
	// (`bun run check && bun test`, a test runner's workers), not only the shell. A group already
	// gone is nothing to signal.
	const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
		trySync(() => process.kill(-pid, signal));
	};

	const one = async (
		name: string,
		command: string,
		cwd: string,
		env: Record<string, string>,
		signal: AbortSignal,
	): Promise<Result> => {
		const started = performance.now();
		const ran = await tryCatch(async () => {
			// `exec 2>&1` puts stderr into stdout for the whole command, so the tail reads the way
			// a terminal would have shown it.
			const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], {
				cwd,
				stdout: "pipe",
				stderr: "ignore",
				env: { ...process.env, ...env },
				detached: true,
			});
			let killed = false;
			let escalate: ReturnType<typeof setTimeout> | undefined;
			const kill = () => {
				killed = true;
				signalGroup(proc.pid, "SIGTERM");
				escalate = setTimeout(
					() => signalGroup(proc.pid, "SIGKILL"),
					KILL_GRACE_MS,
				);
			};
			signal.addEventListener("abort", kill, { once: true });
			// Read to the end: every process in the group has let go of stdout, so none is left.
			const output = await new Response(proc.stdout).text();
			const exit = await proc.exited;
			signal.removeEventListener("abort", kill);
			clearTimeout(escalate);
			// A gate that finished before the stop reached it keeps its real exit.
			return { output, exit: killed && proc.signalCode !== null ? null : exit };
		});
		const ms = Math.round(performance.now() - started);
		if (!ran.ok)
			return {
				name,
				command,
				ok: false,
				exit: null,
				ms,
				tail: ran.error.message,
			};
		return {
			name,
			command,
			ok: ran.value.exit === 0,
			exit: ran.value.exit,
			ms,
			tail: tail(ran.value.output),
		};
	};

	/** Run `gates` in order in `cwd`, stopping at the first that fails or when `signal` aborts. */
	export const run = async (
		gates: Readonly<Record<string, string>>,
		cwd: string,
		env: Record<string, string>,
		signal: AbortSignal,
	): Promise<Result[]> => {
		const results: Result[] = [];
		for (const [name, command] of Object.entries(gates)) {
			if (signal.aborted) break;
			const result = await one(name, command, cwd, env, signal);
			results.push(result);
			if (!result.ok) break;
		}
		return results;
	};

	export const configured = (
		gates: Readonly<Record<string, string>>,
	): boolean => Object.keys(gates).length > 0;

	/** Whether every configured gate ran in `results` and passed. */
	export const passed = (
		gates: Readonly<Record<string, string>>,
		results: readonly Result[],
	): boolean =>
		results.length === Object.keys(gates).length && results.every((r) => r.ok);

	/**
	 * Green: no gates configured, or the latest pass was all green and the tree is the one it
	 * left. A red latest pass, a tree changed since, or none yet, is not.
	 */
	export const green = (
		gates: Readonly<Record<string, string>>,
		runs: readonly Run[],
		tree: string,
	): boolean => {
		if (!configured(gates)) return true;
		const last = runs.at(-1);
		return last !== undefined && last.ok && last.tree === tree;
	};

	/** The latest failed pass for `taskId` since it last passed, for its next brief. */
	export const lastFailure = (
		runs: readonly Run[],
		taskId: string,
	): Result | undefined => {
		const last = runs.findLast((r) => r.taskId === taskId);
		return last && !last.ok ? last.results.find((r) => !r.ok) : undefined;
	};

	const took = (ms: number): string =>
		ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;

	/** `test passed in 12s`, `lint failed (exit 1) in 300ms`. */
	export const describe = (result: Result): string =>
		result.ok
			? `${result.name} passed in ${took(result.ms)}`
			: `${result.name} failed (${result.exit === null ? "killed" : `exit ${result.exit}`}) in ${took(result.ms)}`;

	/** For the stall detector's mark: which gates passed and which failed, last time. */
	export const signature = (run: Run | undefined): string =>
		run
			? run.results.map((r) => `${r.name}:${r.ok ? "ok" : "red"}`).join(",")
			: "";
}
