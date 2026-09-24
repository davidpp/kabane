#!/usr/bin/env bun
/**
 * A throwaway cabane device for trying a change by hand, or for an agent verifying one: its own
 * CABANE_HOME and a seeded git repo in a temp directory, so the first-run screen, the board, the
 * copilot and `/setup-dispatch` run against it without touching `~/.cabane` or the harness
 * configs a real install writes to. Written in TypeScript rather than shell so it runs the same
 * under fish, zsh and bash.
 *
 * It lives in the system temp directory, one per checkout, and not inside the repo: scope
 * detection walks up from the working directory, and inside this checkout it would find
 * cabane's own `.cabane/scope` pin and file every sandbox task under cabane.
 *
 *   bun run sandbox                 the TUI: setup on the first run, then the board
 *   bun run sandbox list            any cabane command, run inside the sandbox repo
 *   bun run sandbox --fresh         wipe the sandbox first
 *   bun run sandbox --harnesses     give the harnesses a sandbox HOME too, so setup's install step
 *                                   runs for real into files under the sandbox (a harness may not
 *                                   be logged in there, so try the copilot without this flag)
 *
 * Without `--harnesses`, CABANE_HARNESSES is set empty and setup finds no agents: the harness
 * configs live under the real HOME, and a sandbox must never register itself there.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { GitFixture } from "../packages/core/scope/git-fixture";

const ROOT = resolve(import.meta.dir, "..");
const SANDBOX = join(tmpdir(), "cabane-sandbox", basename(ROOT));
const REPO = join(SANDBOX, "repo");
const CLI = join(ROOT, "packages/cli/index.ts");

const OWN_FLAGS = ["--fresh", "--harnesses"] as const;
type OwnFlag = (typeof OWN_FLAGS)[number];

const isOwnFlag = (arg: string): arg is OwnFlag =>
	(OWN_FLAGS as readonly string[]).includes(arg);

/** Leading `--fresh`/`--harnesses` are the sandbox's; everything after is cabane's. */
const splitArgs = (argv: string[]): { own: Set<OwnFlag>; rest: string[] } => {
	const own = new Set<OwnFlag>();
	let i = 0;
	for (const arg of argv) {
		if (!isOwnFlag(arg)) break;
		own.add(arg);
		i++;
	}
	const rest = argv.slice(i);
	return { own, rest: rest[0] === "--" ? rest.slice(1) : rest };
};

// A CLAUDE.md and a gate give `/setup-dispatch` something real to read.
const seedRepo = (): void => {
	if (existsSync(REPO)) return;
	mkdirSync(REPO, { recursive: true });
	GitFixture.run(REPO, ["init", "-q"]);
	writeFileSync(
		join(REPO, "CLAUDE.md"),
		"# Sandbox project\n\nGate: `bun test`. Commits: `<issue id> <area>: <what>`.\n",
	);
	writeFileSync(
		join(REPO, "package.json"),
		`${JSON.stringify({ name: "sandbox", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
	);
};

const sandboxEnv = (harnesses: boolean): NodeJS.ProcessEnv => {
	const cabaneHome = join(SANDBOX, ".cabane");
	return harnesses
		? {
				...process.env,
				HOME: SANDBOX,
				CODEX_HOME: join(SANDBOX, ".codex"),
				CABANE_HOME: cabaneHome,
			}
		: { ...process.env, CABANE_HOME: cabaneHome, CABANE_HARNESSES: "" };
};

const { own, rest } = splitArgs(process.argv.slice(2));
if (own.has("--fresh")) rmSync(SANDBOX, { recursive: true, force: true });
seedRepo();
// Codex refuses to start when CODEX_HOME names a directory that does not exist.
if (own.has("--harnesses"))
	mkdirSync(join(SANDBOX, ".codex"), { recursive: true });

console.error(
	`sandbox: ${REPO} · harness installs ${own.has("--harnesses") ? "into the sandbox HOME" : "off"}`,
);
const proc = Bun.spawn([process.execPath, CLI, ...rest], {
	cwd: REPO,
	env: sandboxEnv(own.has("--harnesses")),
	stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
