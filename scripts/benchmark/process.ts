import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { err, ok, trySync, type Result } from "../../packages/core/result";

export type ProcessSpec = {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	seconds: number;
	stdin?: string;
	stdout?: string;
	stderr?: string;
};
export type ProcessResult = {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	interrupted: boolean;
};
/** A minimal environment prevents provider/API overrides and user shell hooks leaking into trials. */
export const cleanEnvironment = (): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SYSTEMROOT",
		"COMSPEC",
	])
		if (process.env[name]) env[name] = process.env[name];
	env.NO_COLOR = "1";
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	return env;
};
export const runProcess = (spec: ProcessSpec): Promise<Result<ProcessResult>> =>
	new Promise((resolve) => {
		const executable = spec.argv[0];
		if (!executable) {
			resolve(err(new Error("Empty command")));
			return;
		}
		const descriptors: number[] = [];
		const close = (): void => {
			for (const fd of descriptors.splice(0)) trySync(() => closeSync(fd));
		};
		const opened = trySync(() => {
			const output = spec.stdout
				? openSync(spec.stdout, "w", 0o600)
				: undefined;
			if (output !== undefined) descriptors.push(output);
			const error = spec.stderr ? openSync(spec.stderr, "w", 0o600) : undefined;
			if (error !== undefined) descriptors.push(error);
			return { output, error };
		});
		if (!opened.ok) {
			close();
			resolve(opened);
			return;
		}
		const started = trySync(() =>
			spawn(executable, spec.argv.slice(1), {
				cwd: spec.cwd,
				env: spec.env,
				detached: process.platform !== "win32",
				stdio: [
					"pipe",
					opened.value.output ?? "pipe",
					opened.value.error ?? "pipe",
				],
			}),
		);
		if (!started.ok) {
			close();
			resolve(err(new Error(`Could not launch ${executable}`)));
			return;
		}
		const child = started.value;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let interrupted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals): void => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-child.pid, signal);
			} catch {
				/* The process may have already exited. */
			}
		};
		const stop = (): void => {
			kill("SIGTERM");
			if (!killTimer) killTimer = setTimeout(() => kill("SIGKILL"), 2000);
		};
		const interrupt = (): void => {
			interrupted = true;
			stop();
		};
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, spec.seconds * 1000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(spec.stdin ?? "");
		child.once("error", () => {
			stderr += `Could not start ${executable}`;
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			kill("SIGKILL");
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			close();
			resolve(ok({ code: code ?? 1, stdout, stderr, timedOut, interrupted }));
		});
	});
export const command = async (
	argv: string[],
	cwd: string,
	env = cleanEnvironment(),
): Promise<Result<string>> => {
	const output = await runProcess({ argv, cwd, env, seconds: 30 });
	if (!output.ok) return output;
	return output.value.code === 0
		? ok(output.value.stdout.trim())
		: err(
				new Error(
					`${argv[0]} ${argv[1] ?? ""} failed (${output.value.code}): ${output.value.stderr.trim()}`,
				),
			);
};
