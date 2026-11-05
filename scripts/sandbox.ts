#!/usr/bin/env bun
/**
 * A throwaway kabane device for trying a change by hand, or for an agent verifying one: its own
 * KABANE_HOME and a seeded git repo in a temp directory, so the first-run screen, the board, the
 * copilot and `/setup-dispatch` run against it without touching `~/.kabane` or the harness
 * configs a real install writes to. Written in TypeScript rather than shell so it runs the same
 * under fish, zsh and bash.
 *
 * It lives in the system temp directory, one per checkout, and not inside the repo: scope
 * detection walks up from the working directory, and inside this checkout it would find
 * cabane's own `.kabane/scope` pin and file every sandbox task under cabane.
 *
 *   bun run sandbox                 the TUI: setup on the first run, then the board
 *   bun run sandbox list            any kabane command, run inside the sandbox repo
 *   bun run sandbox --fresh         wipe the sandbox first
 *   bun run sandbox --harnesses     give the harnesses a sandbox HOME too, so setup's install step
 *                                   runs for real into files under the sandbox (a harness may not
 *                                   be logged in there, so try the copilot without this flag)
 *   bun run sandbox --scripted      the copilot talks to packages/acp/scripts/scripted-agent.ts
 *                                   instead of a real harness: asks, plans and tool calls on cue,
 *                                   no login. Written into the sandbox's config, and taken out
 *                                   again by the next run without the flag
 *
 * Without `--harnesses`, KABANE_HARNESSES is set empty and setup finds no agents: the harness
 * configs live under the real HOME, and a sandbox must never register itself there.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { GitFixture } from "../packages/core/scope/git-fixture";

const ROOT = resolve(import.meta.dir, "..");
const SANDBOX = join(tmpdir(), "kabane-sandbox", basename(ROOT));
const REPO = join(SANDBOX, "repo");
const CLI = join(ROOT, "packages/cli/index.ts");
const KABANE_HOME = join(SANDBOX, ".kabane");
const CONFIG = join(KABANE_HOME, "config.json");
const SCRIPTED_AGENT = join(ROOT, "packages/acp/scripts/scripted-agent.ts");

const OWN_FLAGS = ["--fresh", "--harnesses", "--scripted"] as const;
type OwnFlag = (typeof OWN_FLAGS)[number];

const isOwnFlag = (arg: string): arg is OwnFlag =>
	(OWN_FLAGS as readonly string[]).includes(arg);

/** Leading `--fresh`/`--harnesses`/`--scripted` are the sandbox's; everything after is kabane's. */
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

const sandboxEnv = (harnesses: boolean): NodeJS.ProcessEnv =>
	harnesses
		? {
				...process.env,
				HOME: SANDBOX,
				CODEX_HOME: join(SANDBOX, ".codex"),
				KABANE_HOME,
			}
		: { ...process.env, KABANE_HOME, KABANE_HARNESSES: "" };

const kabane = (args: string[], env: NodeJS.ProcessEnv) =>
	Bun.spawn([process.execPath, CLI, ...args], {
		cwd: REPO,
		env,
		stdio: ["inherit", "inherit", "inherit"],
	});

// The copilot's launch command, through the config key a user would set for their own wrapper. The
// harness stays claude: its id only names the actor and the session's instructions, and the
// scripted agent ignores both. The pane's title says claude for the same reason, so the agent's
// first reply names itself rather than adding a test-only id to the harness registry.
const SCRIPTED_COPILOT = {
	harness: "claude",
	command: process.execPath,
	args: [SCRIPTED_AGENT],
};

/**
 * Point the sandbox's copilot at the scripted agent, or take it off again when the flag is absent;
 * a copilot set by hand is left alone then. With no config yet, `--scripted` initializes one, since
 * the setup screen would otherwise stand between it and the board.
 */
const applyScripted = async (
	scripted: boolean,
	env: NodeJS.ProcessEnv,
): Promise<void> => {
	if (scripted && !existsSync(CONFIG)) await kabane(["init"], env).exited;
	if (!existsSync(CONFIG)) return;
	const config: Record<string, unknown> = JSON.parse(
		readFileSync(CONFIG, "utf8"),
	);
	const ours =
		JSON.stringify(config.copilot) === JSON.stringify(SCRIPTED_COPILOT);
	if (scripted === ours) return;
	if (scripted) config.copilot = SCRIPTED_COPILOT;
	else delete config.copilot;
	writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
};

const { own, rest } = splitArgs(process.argv.slice(2));
if (own.has("--fresh")) rmSync(SANDBOX, { recursive: true, force: true });
seedRepo();
// Codex refuses to start when CODEX_HOME names a directory that does not exist.
if (own.has("--harnesses"))
	mkdirSync(join(SANDBOX, ".codex"), { recursive: true });

const env = sandboxEnv(own.has("--harnesses"));
await applyScripted(own.has("--scripted"), env);

console.error(
	`sandbox: ${REPO} · harness installs ${own.has("--harnesses") ? "into the sandbox HOME" : "off"} · copilot ${own.has("--scripted") ? "scripted" : "real"}`,
);
process.exit(await kabane(rest, env).exited);
