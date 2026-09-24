/**
 * Git for test fixtures and the sandbox — NOT part of the public API.
 *
 * A throwaway repo otherwise inherits the contributor's global and system git
 * config: commit signing (a locked SSH agent fails every fixture commit), global
 * hooks, a missing identity, another default branch. Every test that spawns git
 * goes through `GitFixture.run`, so a fixture behaves the same on any machine.
 */
export namespace GitFixture {
	const CONFIG: Record<string, string> = {
		"user.name": "Test",
		"user.email": "test@example.com",
		"commit.gpgsign": "false",
		"init.defaultBranch": "main",
	};

	/** `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` apply like `git -c`, above every config file. */
	const configEnv = (): Record<string, string> =>
		Object.fromEntries([
			["GIT_CONFIG_COUNT", String(Object.keys(CONFIG).length)],
			...Object.entries(CONFIG).flatMap(([key, value], i) => [
				[`GIT_CONFIG_KEY_${i}`, key],
				[`GIT_CONFIG_VALUE_${i}`, value],
			]),
		]);

	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		...configEnv(),
	};

	/** Runs `git -C <dir> <args>` isolated from the machine's config; throws on a non-zero exit so a broken fixture fails its test. */
	export const run = (dir: string, args: string[]): string => {
		const proc = Bun.spawnSync(["git", "-C", dir, ...args], { env });
		if (proc.exitCode !== 0) {
			throw new Error(
				`git ${args.join(" ")} failed in ${dir}: ${proc.stderr.toString().trim()}`,
			);
		}
		return proc.stdout.toString();
	};
}
