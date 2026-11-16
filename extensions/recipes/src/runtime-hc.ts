// The runtime adapter: the one file that runs `hc` (herdr core). It starts a program in a
// terminal that outlives kabane, reads its state and screen, types into it and ends it. A run's
// session is the terminal's name.
import type { Host, Result } from "@cabane/extension";
import { err, ok, tryCatch, trySync } from "./result";
import type { Runs } from "./runs";
import type { Runtime } from "./runtime";

export namespace HcRuntime {
	/**
	 * The terminal's name: 1 to 32 of a-z, 0-9, - and _, unique among live terminals. The title's
	 * first 22 such characters, then the run id's last six, so `kabane runs` matches it to its run.
	 */
	export const terminalName = (run: string, title: string): string => {
		const head = title
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.slice(0, 22);
		return `${head || "run"}-${run.slice(-6).toLowerCase()}`;
	};

	/** `hc get --json`, the fields the state is read from. */
	type Terminal = {
		state: string;
		status?: { state: string } | null;
		turn?: number;
	};

	const terminalSchema = (z: Host["z"]) =>
		z.object({
			state: z.string(),
			status: z.object({ state: z.string() }).nullish(),
			turn: z.number().int().nonnegative().optional(),
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
	export const stateOf = (terminal: Terminal | null): Runs.State => {
		if (terminal === null || terminal.state !== "live") return "ended";
		const word = terminal.status?.state;
		if (word === "working") return "running";
		if (word === "blocked") return "waiting";
		if (word === undefined)
			return (terminal.turn ?? 0) > 0 ? "idle" : "running";
		return "idle";
	};

	/** The run state `hc get --json` printed, or an err naming hc when it is not that shape. */
	export const seen = (z: Host["z"], stdout: string): Result<Runs.State> => {
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
			name: "hc",
			missing: () => missing(),
			start: async ({ run, title, argv, cwd, labels }) => {
				const name = terminalName(run, title);
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
				return started.ok ? ok(name) : started;
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
