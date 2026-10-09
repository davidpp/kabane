import { runUpdateProcess } from "../packages/cli/src/update-process";
import { err, ok, type Result } from "../packages/core/result";

export const queryRelease = async (
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	const result = await runUpdateProcess(argv, cwd, env, 30_000);
	return result.ok && result.value.code === 0
		? ok(result.value.stdout.trim())
		: err(
				new Error(
					`${argv[0]} ${argv[1] ?? ""} failed; check local authentication/configuration. No automatic retry or rollback.`,
				),
			);
};

/** A human-run local release owns the terminal, including npm's authentication prompts. */
export const runReleaseInteractive = async (
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<void>> => {
	try {
		const child = Bun.spawn(argv, {
			cwd,
			env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await child.exited;
		return code === 0
			? ok(undefined)
			: err(
					new Error(
						`${argv[0]} failed (${code}); inspect the terminal output. No automatic retry or rollback.`,
					),
				);
	} catch {
		return err(
			new Error(`Could not start ${argv[0]}; inspect your local installation.`),
		);
	}
};
