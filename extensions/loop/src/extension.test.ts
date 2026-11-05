// `kabane loop` as the CLI calls it: argv parsed by the shared parser, run against a real tracker.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { parseArgs, Settings } from "@cabane/extension";
import { LoopConfig } from "./config";
import { Elicitation } from "./elicitation";
import { loop } from "./extension";
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

describe("kabane loop start", () => {
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

	it("refuses --worktree and --no-worktree together", async () => {
		const refused = await kabaneLoop(
			"start",
			"K-1",
			"--worktree",
			"--no-worktree",
		);
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toContain("Give one of --worktree and --no-worktree");
	});

	it("refuses a --land mode it does not have", async () => {
		const refused = await kabaneLoop("start", "K-1", "--land", "merge");
		expect(refused.exitCode).toBe(2);
		expect(refused.text).toStartWith("Error: --land must be one of none, pr\n");
	});

	it("takes its own flags and the ones every command takes", async () => {
		const started = await kabaneLoop(
			"start",
			"K-404",
			"--worktree",
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
