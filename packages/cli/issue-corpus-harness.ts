import { join } from "node:path";
import { err, ok } from "@kabane/core";
import { createCorpusTracker as createTracker } from "@kabane/core/testing/issue-corpus";

export const CLI_BIN = join(import.meta.dir, "index.ts");
export const payloadMetrics = (text: string) => ({
	bytes: Buffer.byteLength(text, "utf8"),
	characters: text.length,
	calls: 1,
});

const runCli =
	(cwd: string, env: Record<string, string | undefined>) =>
	async (...args: string[]) => {
		const proc = Bun.spawn([process.execPath, CLI_BIN, ...args], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out, stderr, code };
	};

export const createCorpusTracker = async (
	options: { synthetic?: boolean } = {},
) => {
	const seeded = await createTracker({
		...options,
		initialize: async ({ cwd, env }) => {
			const init = await runCli(cwd, env)(
				"init",
				"--actor",
				"cabane://actor/human/fixture",
				"--device",
				"fixture",
			);
			return init.code === 0 ? ok(undefined) : err(new Error(init.stderr));
		},
	});
	if (!seeded.ok) return seeded;
	const tracker = seeded.value;
	return ok({ ...tracker, run: runCli(tracker.cwd, tracker.env) });
};
