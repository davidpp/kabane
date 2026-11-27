#!/usr/bin/env bun
/**
 * A throwaway kabane device for trying a change by hand, or for an agent verifying one: its own
 * KABANE_HOME and a seeded git repo in a temp directory, so the first-run screen, the board, the
 * copilot and its extensions run against it without touching `~/.kabane` or the harness
 * configs a real install writes to. Written in TypeScript rather than shell so it runs the same
 * under fish, zsh and bash.
 *
 * It lives in the system temp directory, one per checkout, and not inside the repo: scope
 * detection walks up from the working directory, and inside this checkout it would find
 * kabane's own `.kabane/scope` pin and file every sandbox task under kabane.
 *
 *   bun run sandbox                 the TUI: setup on the first run, then the board
 *   bun run sandbox list            any kabane command, run inside the sandbox repo
 *   bun run sandbox --fresh         wipe the sandbox first
 *   bun run sandbox --harnesses     give the harnesses a sandbox HOME too, so setup's install step
 *                                   runs for real into files under the sandbox (a harness may not
 *                                   be logged in there, so try the copilot without this flag)
 *   bun run sandbox --scripted      the copilot, and every session of a loop run, talk to
 *                                   packages/acp/scripts/scripted-agent.ts instead of a real
 *                                   harness: asks, plans and tool calls on cue, an implementer
 *                                   that commits and closes its issue, no login. Written into the
 *                                   sandbox's config, and taken out again by the next run without
 *                                   the flag
 *
 * Without `--harnesses`, KABANE_HARNESSES is set empty and setup finds no agents: the harness
 * configs live under the real HOME, and a sandbox must never register itself there. With or
 * without it, KABANE_JOB_TICK=print makes the job tick's offer and its doctor fix print what they
 * would install: launchd and crontab belong to the user's real session whatever HOME is.
 *
 * A sandbox config that leaves `updates.check` unsaid gets it false, so a sandbox never asks npm
 * for a release. To see the board's release notice, set it true in the sandbox and run with
 * KABANE_BUNDLED=1, because a run from a checkout never shows one.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Harnesses } from "../packages/acp/src/harnesses";
import { GitFixture } from "../packages/core/scope/git-fixture";
import { checkoutExtensions, linkExtensions } from "./link-extensions";

const ROOT = resolve(import.meta.dir, "..");
// Keyed on the checkout's real path, not only its name: every loop worktree is `trees/<n>`, and
// runs sharing `trees/1` would share, or wipe with --fresh, one sandbox.
const SANDBOX = join(
	tmpdir(),
	"kabane-sandbox",
	`${basename(ROOT)}-${createHash("sha256").update(realpathSync(ROOT)).digest("hex").slice(0, 8)}`,
);
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

// A CLAUDE.md and a gate give the dispatch extension's `/setup-dispatch` something real to read.
// The seed has no tests, so the gate passes on none: a harness would otherwise chase a red gate.
// It is committed: a loop run cuts its worktree from HEAD, and the first commit is what the scope
// id derives from, so committing later would move the issues filed before it to another scope.
const seedRepo = (): void => {
	if (existsSync(REPO)) return;
	mkdirSync(REPO, { recursive: true });
	GitFixture.run(REPO, ["init", "-q"]);
	writeFileSync(
		join(REPO, "CLAUDE.md"),
		"# Sandbox project\n\nGate: `bun test --pass-with-no-tests`. Commits: `<issue id> <area>: <what>`.\n",
	);
	writeFileSync(
		join(REPO, "package.json"),
		`${JSON.stringify({ name: "sandbox", private: true, scripts: { test: "bun test --pass-with-no-tests" } }, null, 2)}\n`,
	);
	GitFixture.run(REPO, ["add", "-A"]);
	GitFixture.run(REPO, [
		"commit",
		"-q",
		"-m",
		"chore: seed the sandbox project",
	]);
};

// Claude Code reads CLAUDE_CONFIG_DIR, and Gemini CLI GEMINI_CLI_HOME, before HOME: a contributor's
// own would point setup's install, or a harness the sandbox starts, at their real config.
const {
	CLAUDE_CONFIG_DIR: _claude,
	GEMINI_CLI_HOME: _gemini,
	...inherited
} = process.env;

// KABANE_JOB_TICK=print with or without --harnesses: launchctl bootstrap and crontab act on the
// user's real session whatever HOME says, so a sandbox's job tick is shown, never installed.
const sandboxEnv = (harnesses: boolean): NodeJS.ProcessEnv =>
	harnesses
		? {
				...inherited,
				HOME: SANDBOX,
				CODEX_HOME: join(SANDBOX, ".codex"),
				KABANE_HOME,
				KABANE_JOB_TICK: "print",
			}
		: {
				...process.env,
				KABANE_HOME,
				KABANE_HARNESSES: "",
				KABANE_JOB_TICK: "print",
			};

// Through the entry's own hashbang, as a linked kabane starts: the sandbox renders with the React
// build a linked or installed kabane does.
const kabane = (args: string[], env: NodeJS.ProcessEnv) =>
	Bun.spawn([CLI, ...args], {
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

// A loop run's sessions, through the global layer of the setting a user names a local adapter build
// with (`loop.harnesses`), so `loop start` spends no quota. Every harness, not only the default
// implementer: a `tier:codex/...` tag or a codex verifier would otherwise reach the real one.
const SCRIPTED_LOOP = { command: process.execPath, args: [SCRIPTED_AGENT] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

// `loop.harnesses.<id>` set to the scripted agent for every harness, or each taken off when it is
// ours; emptied objects go with them.
const scriptLoop = (config: Json, scripted: boolean): void => {
	const loop = isObject(config.loop) ? config.loop : {};
	const harnesses = isObject(loop.harnesses) ? loop.harnesses : {};
	for (const id of Harnesses.IDS) {
		if (scripted) harnesses[id] = SCRIPTED_LOOP;
		else if (same(harnesses[id], SCRIPTED_LOOP)) delete harnesses[id];
	}
	if (Object.keys(harnesses).length > 0) loop.harnesses = harnesses;
	else delete loop.harnesses;
	if (Object.keys(loop).length > 0) config.loop = loop;
	else delete config.loop;
};

/**
 * Point the sandbox's copilot and its loop runs' claude sessions at the scripted agent, or take
 * them off again when the flag is absent; a copilot or launch set by hand is left alone then. With
 * no config yet, `--scripted` initializes one, since the setup screen would otherwise stand between
 * it and the board.
 */
const applyScripted = async (
	scripted: boolean,
	env: NodeJS.ProcessEnv,
): Promise<void> => {
	if (scripted && !existsSync(CONFIG)) await kabane(["init"], env).exited;
	if (!existsSync(CONFIG)) return;
	const config: Json = JSON.parse(readFileSync(CONFIG, "utf8"));
	const before = JSON.stringify(config);
	if (scripted) config.copilot = SCRIPTED_COPILOT;
	else if (same(config.copilot, SCRIPTED_COPILOT)) delete config.copilot;
	scriptLoop(config, scripted);
	if (JSON.stringify(config) === before) return;
	writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
};

/** `updates.check` false unless the sandbox's config says otherwise; no config yet is left alone. */
const quietUpdates = (): void => {
	if (!existsSync(CONFIG)) return;
	const config: Record<string, unknown> = JSON.parse(
		readFileSync(CONFIG, "utf8"),
	);
	const updates = config.updates;
	const said =
		typeof updates === "object" &&
		updates !== null &&
		"check" in updates &&
		updates.check !== undefined;
	if (said) return;
	config.updates = {
		...(typeof updates === "object" ? updates : {}),
		check: false,
	};
	writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
};

const { own, rest } = splitArgs(process.argv.slice(2));
if (own.has("--fresh")) rmSync(SANDBOX, { recursive: true, force: true });
seedRepo();
// The checkout's own extensions, linked unless the sandbox installed one of that name: installed,
// not enabled, as `kabane config set extensions <name> --layer global` would find them.
linkExtensions(ROOT, KABANE_HOME, checkoutExtensions(ROOT));
// Codex refuses to start when CODEX_HOME names a directory that does not exist.
if (own.has("--harnesses"))
	mkdirSync(join(SANDBOX, ".codex"), { recursive: true });

const env = sandboxEnv(own.has("--harnesses"));
await applyScripted(own.has("--scripted"), env);
quietUpdates();

console.error(
	`sandbox: ${REPO} · harness installs ${own.has("--harnesses") ? "into the sandbox HOME" : "off"} · copilot and loop ${own.has("--scripted") ? "scripted" : "real"}`,
);
process.exit(await kabane(rest, env).exited);
