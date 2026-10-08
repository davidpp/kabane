import { err, ok, type Result } from "../../core/result";

export type ProcessReply = { code: number; stdout: string };

/** Child diagnostics may contain registry credentials; never relay their raw bytes. */
export const runUpdateProcess = async (
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs = 15_000,
	maxBytes = 1_048_576,
): Promise<Result<ProcessReply>> => {
	try {
		const child = Bun.spawn(argv, {
			cwd,
			env,
			detached: true,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		let stopped: string | undefined;
		const stop = (reason: string): void => {
			stopped ??= reason;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			for (const reader of readers) void reader.cancel().catch(() => {});
		};
		const timer = setTimeout(() => stop("Bun operation timed out."), timeoutMs);
		const consume = async (
			stream: ReadableStream<Uint8Array>,
			capture: boolean,
		): Promise<string> => {
			const reader = stream.getReader();
			readers.push(reader);
			const decoder = new TextDecoder();
			let bytes = 0;
			let text = "";
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > maxBytes) {
						stop("Bun operation exceeded its output limit.");
						await reader.cancel();
						break;
					}
					if (capture) text += decoder.decode(chunk.value, { stream: true });
				}
				return text + (capture ? decoder.decode() : "");
			} finally {
				reader.releaseLock();
			}
		};
		try {
			const [stdout, , code] = await Promise.all([
				consume(child.stdout, true),
				consume(child.stderr, false),
				child.exited,
			]);
			return stopped ? err(new Error(stopped)) : ok({ code, stdout });
		} finally {
			clearTimeout(timer);
			child.kill();
		}
	} catch {
		return err(
			new Error(
				"Could not execute the Bun operation; check your Bun installation manually.",
			),
		);
	}
};
