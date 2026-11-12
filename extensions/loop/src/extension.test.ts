// `kabane loop` as the CLI calls it: argv parsed by the shared parser, run against a real tracker.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { parseArgs, Settings } from "@cabane/extension";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Elicitation } from "./elicitation";
import { loop, start } from "./extension";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-extension-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const kabaneLoop = (...argv: string[]) => {
	const command = loop.commands?.find((c) => c.name === "loop");
	if (!command) throw new Error("no loop command");
	return command.run(parseArgs(argv), {
		home,
		store: home,
		cwd: home,
		actor: "cabane://actor/human/test",
		harnessMode: "auto",
		settings: Settings.port(async () => ok([])),
	});
};

// The runner `start` spawns: the real `Loop.run` on this test's tracker, as `kabane loop run` runs
// it, with no harness a lens session could reach.
const RUNNER = [
	`import ${JSON.stringify(Bun.resolveSync("@cabane/core/testing", import.meta.dir))};`,
	`import { Loop } from ${JSON.stringify(join(import.meta.dir, "commands.ts"))};`,
	`const home = process.env.KABANE_HOME ?? "";`,
	`const ran = await Loop.run({ home, basePath: home, kabaneBin: "/nonexistent/kabane", overrides: { claude: { command: "/nonexistent/harness" } } }, process.argv[1] ?? "");`,
	`process.exit(ran.ok ? 0 : 1);`,
].join("\n");

describe("kabane loop start", () => {
	it("says where to move a lens read from the old directory, and nothing once the skill has it", async () => {
		const repo = join(home, "repo");
		const legacy = join(repo, ".kabane/loop/lenses/security.md");
		const skill = join(
			repo,
			".claude/skills/dispatch/references/lenses/security.md",
		);
		const created = await Planner.addTask(home, {
			title: "lone",
			kind: "issue",
			state: "done",
		});
		if (!created.ok) throw created.error;
		const id = created.value.id;
		const deps = {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			cwd: home,
			actor: "cabane://actor/human/test",
			mode: "auto" as const,
			settings: Settings.port(async () => ok([])),
			runner: (runId: string) => [process.execPath, "-e", RUNNER, runId],
		};
		const argv = [
			"start",
			id,
			"--dir",
			repo,
			"--no-worktree",
			"--lens",
			"security",
		];
		const startOnce = async () => {
			const started = await start(parseArgs(argv), deps, id);
			const runId = RunStore.RunSchema.parse(started.json).id;
			const stopped = await Loop.stop({ home, waitMs: 15_000 }, runId);
			expect(stopped.ok && RunStore.isLive(stopped.value.status)).toBe(false);
			return started;
		};
		mkdirSync(join(repo, ".kabane/loop/lenses"), { recursive: true });
		writeFileSync(legacy, "# Security\n");
		const moved = await startOnce();
		expect(moved.exitCode).toBe(0);
		expect(moved.text).toContain(
			`  note: lens security is read from ${legacy}; move it to ${skill}`,
		);
		mkdirSync(join(repo, ".claude/skills/dispatch/references/lenses"), {
			recursive: true,
		});
		writeFileSync(skill, "# Security\n");
		const overridden = await startOnce();
		expect(overridden.exitCode).toBe(0);
		expect(overridden.text).not.toContain("note: lens");
	}, 30_000);

	it("refuses a flag it does not take, rather than starting without it", async () => {
		const refused = await kabaneLoop(
			"start",
			"K-1",
			"--work-tree",
			"--gates",
			"test=bun test",
		);
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			"Error: Unknown loop start flags: --work-tree, --gates\n",
		);
	});

	it("refuses the removed wall-time flag", async () => {
		const refused = await kabaneLoop("start", "K-1", "--wall-minutes", "120");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			"Error: Unknown loop start flag: --wall-minutes\n",
		);
	});

	it("refuses --no-worktree with a value, which would otherwise start a worktree run", async () => {
		const refused = await kabaneLoop("start", "K-1", "--no-worktree", "yes");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			'Error: --no-worktree takes no value, not "yes"\n',
		);
	});

	it("refuses a switch and its --no- form together", async () => {
		const refused = await kabaneLoop(
			"start",
			"K-1",
			"--worktree",
			"--no-worktree",
		);
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toContain("Give one of --worktree and --no-worktree");
		const recheck = await kabaneLoop(
			"start",
			"K-1",
			"--recheck",
			"--no-recheck",
		);
		expect(recheck.exitCode).toBe(2);
		expect(recheck.text).toContain("Give one of --recheck and --no-recheck");
	});

	it("refuses a --land mode it does not have", async () => {
		const refused = await kabaneLoop("start", "K-1", "--land", "merge");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith("Error: --land must be one of none, pr\n");
	});

	it("refuses an --isolation it does not have", async () => {
		const refused = await kabaneLoop("start", "K-1", "--isolation", "none");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			"Error: --isolation must be one of worktree, shared\n",
		);
	});

	it("takes its own flags and the ones every command takes", async () => {
		const started = await kabaneLoop(
			"start",
			"K-404",
			"--worktree",
			"--no-recheck",
			"--isolation",
			"shared",
			"--land",
			"pr",
			"--as",
			"cabane://actor/human/test",
		);
		// Past the flags: the parent is what is missing.
		expect(started.exitCode).toBe(1);
		expect(started.text).not.toContain("Unknown loop start flag");
	});
});

describe("kabane loop status, after a landing", () => {
	it("says why a branch did not land, and the command that tries again", async () => {
		const config = LoopConfig.Schema.safeParse({ land: "pr" });
		if (!config.success) throw config.error;
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: "01PARENT",
			parentShortId: "K-1",
			projectDir: home,
			config: config.data,
			status: "completed",
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
			landing: {
				at: new Date().toISOString(),
				ok: false,
				summary: "Not landed: git push failed.",
			},
		});
		if (!created.ok) throw created.error;

		const shown = await kabaneLoop("status", "run-1");

		expect(shown.text).toContain(
			"\n  Not landed: git push failed.\n  land again: kabane loop land run-1",
		);
	});
});

describe("kabane loop status, its claims", () => {
	it("says what ran each claim: harness, agent, and model with where it came from", async () => {
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		const at = new Date().toISOString();
		const claim = (lane: string, extra: Partial<RunStore.Claim>) => ({
			taskId: lane,
			shortId: lane,
			harness: "claude",
			lane,
			sessionId: `s-${lane}`,
			startedAt: at,
			continuations: 0,
			...extra,
		});
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: "01PARENT",
			parentShortId: "K-1",
			projectDir: home,
			config: config.data,
			status: "completed",
			createdAt: at,
			claims: [
				claim("K-2", {
					model: "haiku",
					modelSource: "tier",
					tier: "fast",
					endedAt: at,
					outcome: "done",
				}),
				claim("K-3", {
					agent: "board-ui",
					model: "opus",
					modelSource: "agent",
				}),
				claim("K-4", {
					harness: "codex",
					model: "gpt-6-astra",
					modelSource: "default",
				}),
				claim("K-5", { model: "sonnet", modelSource: "run" }),
			],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
		if (!created.ok) throw created.error;

		const shown = await kabaneLoop("status", "run-1");

		expect(shown.text).toContain(
			[
				"  K-2  claude  model haiku (tier fast)  done",
				"  K-3  claude  agent board-ui  model opus (board-ui's pin)  running",
				"  K-4  codex  model gpt-6-astra (the harness's default)  running",
				"  K-5  claude  model sonnet (the run's model)  running",
			].join("\n"),
		);
	});
});

describe("kabane loop status, after a landing its runner died in", () => {
	it("says the landing is not undone, what to put back, and the command that goes on", async () => {
		const config = LoopConfig.Schema.safeParse({ land: "pr" });
		if (!config.success) throw config.error;
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: "01PARENT",
			parentShortId: "K-1",
			projectDir: home,
			worktree: "/tmp/run-1/worktree",
			branch: "k-1-fix",
			config: config.data,
			status: "failed",
			exit: { reason: RunStore.LANDING_UNRECOVERED },
			landingFrom: "0123456789abcdef0123",
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
		if (!created.ok) throw created.error;

		const shown = await kabaneLoop("status", "run-1");

		expect(shown.text).toContain(
			"  interrupted landing not undone: put branch k-1-fix in /tmp/run-1/worktree back at 0123456789ab (remove a lock file git left there if it says so), then kabane loop resume run-1",
		);
	});
});

describe("kabane loop prune", () => {
	it("says so when no run has a worktree left to remove", async () => {
		const pruned = await kabaneLoop("prune");
		expect(pruned.exitCode).toBe(0);
		expect(pruned.text).toBe("No run worktrees left");
	});
});

describe("kabane loop status", () => {
	it("lines a form question's later lines up under its first, with its choices", async () => {
		const issue = await Planner.addTask(home, {
			kind: "issue",
			state: "next",
			title: "lone",
		});
		if (!issue.ok) throw issue.error;
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: issue.value.id,
			parentShortId: issue.value.shortId ?? issue.value.id,
			projectDir: home,
			config: config.data,
			status: "running",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
		if (!created.ok) throw created.error;
		const session = await Planner.startSession(home, {
			taskId: issue.value.id,
			agent: "claude",
			externalRef: RunStore.sessionRef("run-1"),
		});
		if (!session.ok) throw session.error;
		const request = {
			message: "Which store should the cache use?",
			fields: [
				{
					key: "question_0",
					title: "Store",
					required: false,
					type: "choice" as const,
					options: [{ value: "Redis", label: "Redis" }],
				},
			],
		};
		const [store] = Elicitation.questions(request.fields);
		if (!store) throw new Error("no question");
		const asked = await Planner.addActivity(home, {
			sessionId: session.value.id,
			type: "question",
			body: Elicitation.body("claude", request, store, { index: 0, total: 1 }),
		});
		if (!asked.ok) throw asked.error;

		const status = await kabaneLoop("status", "run-1");
		expect(status.text).toContain(
			[
				`  waiting on you: ${issue.value.shortId} claude asks: Which store should the cache use?`,
				"    Store",
				"    1. Redis",
				"    2. skip",
				"    3. decline",
				`    kabane loop answer ${asked.value.id} <option>`,
			].join("\n"),
		);
	});
});

describe("kabane loop advise", () => {
	it("prints the advised settings with their reasons, and what each subtask's tags run it on", async () => {
		writeFileSync(
			join(home, "package.json"),
			JSON.stringify({ scripts: { test: "bun test" } }),
		);
		writeFileSync(join(home, "bun.lock"), "");
		mkdirSync(join(home, ".claude/agents"), { recursive: true });
		writeFileSync(
			join(home, ".claude/agents/docs-writer.md"),
			"---\nname: docs-writer\nmodel: haiku\n---\nWrite docs.\n",
		);
		const add = async (title: string, extra: Record<string, unknown>) => {
			const created = await Planner.addTask(home, {
				title,
				kind: "issue",
				state: "next",
				...extra,
			});
			if (!created.ok) throw created.error;
			return created.value;
		};
		const parent = await add("parser", {});
		const header = await add("header", {
			parentTaskId: parent.id,
			tags: ["tier:fast"],
			description: "Change src/parser.ts to read the header.",
		});
		const body = await add("body", {
			parentTaskId: parent.id,
			tags: ["tier:codex/frontier", "agent:reviewer"],
			description: "Change src/parser.ts to read the body.",
		});
		const docs = await add("docs", {
			parentTaskId: parent.id,
			tags: ["agent:docs-writer", "tier:balanced", "area:docs"],
			description: "Write docs/parser.md.",
		});
		const command = loop.commands?.find((c) => c.name === "loop");
		if (!command) throw new Error("no loop command");
		const advised = await command.run(
			parseArgs(["advise", parent.shortId ?? parent.id]),
			{
				home,
				store: home,
				cwd: home,
				actor: "cabane://actor/human/test",
				harnessMode: "auto",
				settings: Settings.port(async () =>
					ok([
						{
							layer: "global",
							label: "test",
							value: {
								tiers: {
									claude: { fast: "claude-haiku-4-5" },
									codex: { frontier: "gpt-5.5" },
								},
							},
						},
					]),
				),
			},
		);
		expect(advised.exitCode).toBe(0);
		const lines = advised.text.split("\n");
		expect(lines.slice(1, 8)).toEqual([
			"  implementer claude  model unset  tiers frontier, balanced, fast",
			"advised:",
			`  budget.concurrency 1 (now 2, the default with worktrees): src/parser.ts referenced by ${header.shortId}, ${body.shortId} — potential merge conflict if run in parallel`,
			'  gates test="bun run test" (now none): package.json scripts, using bun from the lockfile',
			"  setup bun install (now unset): install dependencies in each worktree using the project's lockfile",
			'  start with: --concurrency 1 --gate test="bun run test"',
			'  no start flag, a setting: loop.setup "bun install"',
		]);
		expect(lines.slice(8)).toEqual([
			"subtasks:",
			`  ${header.shortId}  header`,
			"    tier:fast  claude  model claude-haiku-4-5 (tier fast)",
			`  ${body.shortId}  body`,
			"    tier:codex/frontier agent:reviewer  codex  model gpt-5.5 (tier frontier)",
			"    note: codex has no way to select a named agent, so it runs without reviewer",
			`  ${docs.shortId}  docs`,
			"    agent:docs-writer tier:balanced  claude  agent docs-writer  model haiku (docs-writer's pin)",
			"    note: tier balanced not applied: agent docs-writer pins haiku",
		]);
	});

	it("refuses a flag start does not take", async () => {
		const refused = await kabaneLoop("advise", "K-1", "--work-tree");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith(
			"Error: Unknown loop start flag: --work-tree\n",
		);
	});
});
