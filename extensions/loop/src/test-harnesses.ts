// What a loop test that builds runner deps launches, for every harness id. A session the test did
// not mean to reach a harness then fails at spawn instead of falling through to the run's setting
// or to the registry's adapter, which is `npx` on the maintainer's real login.
//
// `overrides` also points the adapters' CLI variables (`Harnesses.installedCli`) at a path that
// does not exist until the test calling it finishes: an adapter a regression still reached would
// find no CLI to run, so it could not spend anything. It is the loop's test support only, never a
// preload: `packages/acp/src/client.harness.test.ts` launches the real adapters on purpose.
import { onTestFinished } from "bun:test";
import type { Harnesses } from "@cabane/acp";
import type { LoopConfig } from "./config";

export namespace TestHarnesses {
	/** A command no machine has: a session launched on it fails at once. */
	const NONE: Harnesses.Overrides = { command: "/nonexistent/harness" };

	/** `NONE` for every harness: what a runner a test spawns as its own process is given. */
	export const NOWHERE: LoopConfig.Own = {
		claude: NONE,
		codex: NONE,
		gemini: NONE,
	};

	/** The CLI each adapter would run, while a test that called `overrides` runs. */
	export const CLIS = {
		CLAUDE_CODE_EXECUTABLE: "/nonexistent/claude",
		CODEX_PATH: "/nonexistent/codex",
	} as const;

	// Once per test: a second call in the same test finds them pointed already.
	const blockClis = (): void => {
		if (process.env.CLAUDE_CODE_EXECUTABLE === CLIS.CLAUDE_CODE_EXECUTABLE)
			return;
		const saved = Object.keys(CLIS).map(
			(name) => [name, process.env[name]] as const,
		);
		Object.assign(process.env, CLIS);
		onTestFinished(() => {
			for (const [name, value] of saved)
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
		});
	};

	/** Inside a test: `given` for the harnesses it names, `NONE` for the rest. */
	export const overrides = (
		given: Partial<Record<Harnesses.Id, Harnesses.Overrides>> = {},
	): LoopConfig.Own => {
		blockClis();
		return {
			claude: given.claude ?? NONE,
			codex: given.codex ?? NONE,
			gemini: given.gemini ?? NONE,
		};
	};
}
