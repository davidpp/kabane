// The runtime adapter: the one file that runs `hc` (herdr core). It starts a program in a
// terminal that outlives kabane, reads its state and screen, types into it and ends it. Swapping
// hc for another runtime replaces this file and keeps `Runtime`.
import type { Host, Result } from "@cabane/extension";
import { err, ok, tryCatch, trySync } from "./result";
import type { Runs } from "./runs";

export namespace HcRuntime {
	type Start = {
		argv: readonly string[];
		cwd: string;
		/** The terminal's name: 1 to 32 of a-z, 0-9, - and _, unique among live terminals. */
		name: string;
		labels: Readonly<Record<string, string>>;
	};

	/** What a terminal is doing, as a run state, and the hc words it was read from. */
	type Seen = { state: Runs.State; from: string };

	export type Runtime = {
		/** Why the runtime cannot start anything here, or undefined. */
		missing(): string | undefined;
		start(start: Start): Promise<Result<{ terminal: string }>>;
		get(terminal: string): Promise<Result<Seen>>;
		read(terminal: string): Promise<Result<string>>;
		send(terminal: string, text: string): Promise<Result<void>>;
		stop(terminal: string): Promise<Result<void>>;
		/** Put this terminal on it until the human detaches; resolves to hc's exit code. */
		attach(terminal: string): Promise<Result<number>>;
	};

	/** `hc get --json`, the fields the state is read from. */
	type Terminal = {
		state: string;
		status?: { state: string } | null;
		turn?: number;
		reason?: string | null;
	};

	const terminalSchema = (z: Host["z"]) =>
		z.object({
			state: z.string(),
			status: z.object({ state: z.string() }).nullish(),
			turn: z.number().int().nonnegative().optional(),
			reason: z.string().nullish(),
		});

	/** hc's error envelope on a failed `--json` call. */
	const errorSchema = (z: Host["z"]) =>
		z.object({ error: z.object({ message: z.string() }) });

	/**
	 * A terminal's run state; null is a terminal hc no longer has. `status.state` is the program's
	 * own word (idle, working, done, blocked or error) and is null when it never said; `turn`
	 * counts the times it left working. A program that never reports reads as running until it
	 * exits. Values recorded from real output in `AGENTS.md`.
	 */
	export const stateOf = (terminal: Terminal | null): Seen => {
		if (terminal === null) return { state: "ended", from: "gone" };
		if (terminal.state !== "live")
			return {
				state: "ended",
				from: `${terminal.state}${terminal.reason ? ` (${terminal.reason})` : ""}`,
			};
		const word = terminal.status?.state;
		const from = `live, status ${word ?? "null"}, turn ${terminal.turn ?? 0}`;
		if (word === "working") return { state: "running", from };
		if (word === "blocked") return { state: "waiting", from };
		if (word === undefined)
			return { state: (terminal.turn ?? 0) > 0 ? "idle" : "running", from };
		return { state: "idle", from };
	};

	/** The run state `hc get --json` printed, or an err naming hc when it is not that shape. */
	export const seen = (z: Host["z"], stdout: string): Result<Seen> => {
		const json = trySync((): unknown => JSON.parse(stdout));
		if (!json.ok)
			return err(new Error(`hc get printed no JSON: ${stdout.slice(0, 200)}`));
		const parsed = terminalSchema(z).safeParse(json.value);
		return parsed.success
			? ok(stateOf(parsed.data))
			: err(
					new Error(
						`hc get --json printed a terminal kabane cannot read: ${parsed.error.message}`,
					),
				);
	};

	/** Why hc cannot be used, or undefined when it is on PATH. */
	export const missing = (path = process.env.PATH): string | undefined =>
		Bun.which("hc", { PATH: path ?? "" }) === null
			? "hc (herdr core) is not on PATH: kabane run starts every recipe in an hc terminal. Install it, or put it on PATH"
			: undefined;

	type Ran = { code: number; stdout: string; stderr: string };

	const NOT_FOUND = 3;

	const exec = (args: readonly string[]): Promise<Result<Ran>> =>
		tryCatch(async () => {
			const child = Bun.spawn(["hc", ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		});

	/** hc's own message for a failed call: its JSON error, else the line it printed. */
	const failure = (z: Host["z"], command: string, ran: Ran): Error => {
		const text = (ran.stdout.trim() || ran.stderr.trim()).split("\n")[0] ?? "";
		const json = trySync((): unknown => JSON.parse(text));
		const parsed = json.ok ? errorSchema(z).safeParse(json.value) : undefined;
		const message = parsed?.success ? parsed.data.error.message : text;
		return new Error(
			`hc ${command} failed (exit ${ran.code})${message ? `: ${message}` : ""}`,
		);
	};

	/** The runtime over the `hc` on PATH; `z` is the host's, which reads hc's JSON. */
	export const runtime = (z: Host["z"]): Runtime => {
		const call = async (
			command: string,
			args: readonly string[],
		): Promise<Result<string>> => {
			const blocked = missing();
			if (blocked !== undefined) return err(new Error(blocked));
			const ran = await exec([command, ...args]);
			if (!ran.ok) return ran;
			return ran.value.code === 0
				? ok(ran.value.stdout)
				: err(failure(z, command, ran.value));
		};

		return {
			missing: () => missing(),
			start: async ({ argv, cwd, name, labels }) => {
				const started = await call("run", [
					"--bg",
					"--json",
					"--no-parent",
					"--cwd",
					cwd,
					"--name",
					name,
					...Object.entries(labels).flatMap(([key, value]) => [
						"--label",
						`${key}=${value}`,
					]),
					"--",
					...argv,
				]);
				return started.ok ? ok({ terminal: name }) : started;
			},
			get: async (terminal) => {
				const blocked = missing();
				if (blocked !== undefined) return err(new Error(blocked));
				const ran = await exec(["get", "--json", terminal]);
				if (!ran.ok) return ran;
				if (ran.value.code === NOT_FOUND) return ok(stateOf(null));
				if (ran.value.code !== 0) return err(failure(z, "get", ran.value));
				return seen(z, ran.value.stdout);
			},
			read: (terminal) => call("read", [terminal]),
			send: async (terminal, text) => {
				const sent = await call("send", ["--json", terminal, text]);
				return sent.ok ? ok(undefined) : sent;
			},
			stop: async (terminal) => {
				const stopped = await call("kill", ["--json", terminal]);
				return stopped.ok ? ok(undefined) : stopped;
			},
			attach: async (terminal) => {
				const blocked = missing();
				if (blocked !== undefined) return err(new Error(blocked));
				return tryCatch(
					() =>
						Bun.spawn(["hc", "attach", terminal], {
							stdio: ["inherit", "inherit", "inherit"],
						}).exited,
				);
			},
		};
	};
}
