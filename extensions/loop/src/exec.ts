// The user's own command-line tools as the loop runs them: git, and gh for landing. Asynchronous,
// because the runner calls them: a commit runs the user's hooks and gh waits on the network, and a
// synchronous spawn would stall every session's stream and timer until they end.
import { basename } from "node:path";
import { err, ok, type Result, tryCatch } from "@cabane/core";

export namespace Exec {
	/** One tool, `<tool> <args>` in `cwd`: its stdout, or an error carrying what it said. */
	export type Tool = (cwd: string, args: string[]) => Promise<Result<string>>;

	// The flags whose value is content, per tool: a pull request's title and body, a commit's
	// message. An error names the flag and never its value, which would otherwise reach the run's
	// trace and the parent's comments.
	const CONTENT: Readonly<Record<string, readonly string[]>> = {
		gh: ["--title", "-t", "--body", "-b", "--body-file", "-F"],
		git: ["--message", "-m", "--file", "-F"],
	};
	const HIDDEN = "<…>";
	// Any other argument too long for a line of an error is cut short.
	const ARG_CHARS = 60;

	const shownArgs = (command: string, args: readonly string[]): string[] => {
		const content = CONTENT[basename(command)] ?? [];
		return args.map((arg, i) => {
			const flag = content.find((f) => arg.startsWith(`${f}=`));
			if (flag) return `${flag}=${HIDDEN}`;
			if (i > 0 && content.includes(args[i - 1] ?? "")) return HIDDEN;
			const line = arg.split("\n")[0] ?? "";
			return line.length > ARG_CHARS || line !== arg
				? `${line.slice(0, ARG_CHARS)}…`
				: arg;
		});
	};

	/** `command` on the user's PATH, with their environment and config. */
	export const tool =
		(command: string): Tool =>
		async (cwd, args) => {
			const ran = await tryCatch(async () => {
				const proc = Bun.spawn([command, ...args], {
					cwd,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exit] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { stdout, stderr, exit };
			});
			if (!ran.ok) return ran;
			return ran.value.exit === 0
				? ok(ran.value.stdout)
				: err(
						new Error(
							`${basename(command)} ${shownArgs(command, args).join(" ")} failed in ${cwd}: ${ran.value.stderr.trim()}`,
						),
					);
		};
}
