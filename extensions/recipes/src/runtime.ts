// What a run starts in. A runtime starts a program, reports its state and ends it; the handle
// `start` returns is the run's `session`, and only the runtime reads it. A terminal is optional:
// a runtime without one has no `read`, `send` or `attach`, and `kabane runs` says so.
import type { Result } from "@cabane/extension";
import type { Runs } from "./runs";

export type Runtime = {
	/** The name a run row stores in `runtime`. */
	name: string;
	/** Why the runtime cannot start anything here, or undefined. */
	missing(): string | undefined;
	/** Starts the program and resolves to its session, the runtime's own handle for it. */
	start(start: Runtime.Start): Promise<Result<string>>;
	get(session: string): Promise<Result<Runs.State>>;
	stop(session: string): Promise<Result<void>>;
	/**
	 * The session the runtime holds for run `run`, live or finished, or undefined when it has none.
	 * Recovers a run recorded as starting whose start was interrupted before its session was written.
	 */
	find?(run: string): Promise<Result<string | undefined>>;
	/** The session's screen. */
	read?(session: string): Promise<Result<string>>;
	/**
	 * Types `text` into the session. Resolves to `waiting` without typing when the program waits on
	 * its human (a permission, a question) and `force` is not set: typing would answer its dialog.
	 */
	send?(
		session: string,
		text: string,
		options?: { force?: boolean },
	): Promise<Result<"sent" | "waiting">>;
	/** Puts this terminal on the session until the human detaches; resolves to the exit code. */
	attach?(session: string): Promise<Result<number>>;
};

export namespace Runtime {
	export type Start = {
		/** The run's id. */
		run: string;
		/** A short human name for what runs, such as the recipe's. */
		title: string;
		argv: readonly string[];
		cwd: string;
		labels: Readonly<Record<string, string>>;
	};
}
