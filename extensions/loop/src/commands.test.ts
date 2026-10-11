import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { detectScope } from "@cabane/core/scope";
import { Loop } from "./commands";
import { Permission } from "./permission";
import { RunStore } from "./store";

// `start`'s refusals, which all come before a runner is spawned. Starting a real runner is the
// sandbox check, not a unit test.
let root = "";
let home = "";
let repo = "";

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent/kabane",
	cwd: repo,
	// Never reached: every case below is refused before the spawn.
	runner: () => ["/nonexistent/runner"],
});

const add = async (title: string, extra: Record<string, unknown> = {}) => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-start-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const repoScope = async (): Promise<string> => {
	const scope = await detectScope(repo, { home, detectExtensions: false });
	if (!scope) throw new Error("the fixture repo has no scope");
	return scope.scopeUri;
};

describe("Loop.start refusals", () => {
	it("refuses a parent with no subtasks", async () => {
		const parent = await add("parent", { scopeUri: await repoScope() });
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("no subtasks");
	});

	it("refuses a directory that is not the parent's scope, and names --dir", async () => {
		const parent = await add("parent", { scopeUri: "jake://scope/elsewhere" });
		await add("child", {
			parentTaskId: parent.id,
			scopeUri: "jake://scope/elsewhere",
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) {
			expect(started.error.message).toContain("jake://scope/elsewhere");
			expect(started.error.message).toContain("--dir");
		}
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toEqual([]);
	});

	it("matches the scope by id, whatever extensions the parent's scope carries", async () => {
		const scopeUri = `${await repoScope()}?package=sandbox`;
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		const started = await Loop.start(deps(), { parent: parent.id });
		// Past the folder check: the run is written and only the (nonexistent) runner fails.
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).not.toContain("--dir");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value.map((r) => [r.status, r.projectDir])).toEqual([
			["failed", repo],
		]);
	});

	it("refuses a parent that already has a live run", async () => {
		const scopeUri = await repoScope();
		const parent = await add("parent", { scopeUri });
		await add("child", { parentTaskId: parent.id, scopeUri });
		RunStore.create(home, {
			version: 1,
			id: "live-run",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo,
			config: {
				implementer: "claude",
				budget: {
					concurrency: 1,
					wallMinutes: 1,
					continuations: 0,
					currency: "USD",
				},
				stallAfter: 1,
			},
			status: "running",
			pid: process.pid,
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: { paused: false, skipped: [], next: [] },
		});
		const started = await Loop.start(deps(), { parent: parent.id });
		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.error.message).toContain("live-run");
	});
});

describe("Loop.answer", () => {
	const HUMAN = "cabane://actor/human/david";

	// A loop session of run `runId` blocked on a relayed permission request.
	const blocked = async (runId: string) => {
		mkdirSync(RunStore.paths(home, runId).dir, { recursive: true });
		const task = await add("child");
		const session = await Planner.startSession(home, {
			taskId: task.id,
			agent: "claude",
			externalRef: RunStore.sessionRef(runId),
		});
		if (!session.ok) throw session.error;
		const question = await Planner.addActivity(home, {
			sessionId: session.value.id,
			type: "question",
			body: Permission.body("claude", {
				toolCallId: "toolu_01",
				title: "Write notes.md",
				options: [
					{ id: "allow", name: "Allow", kind: "allow_once" },
					{ id: "reject", name: "Reject", kind: "reject_once" },
				],
			}),
		});
		if (!question.ok) throw question.error;
		return { sessionId: session.value.id, questionId: question.value.id };
	};

	it("writes the chosen option's label as the decision and notes who answered", async () => {
		const { sessionId, questionId } = await blocked("run-1");
		const listed = await Loop.questions({ basePath: home }, "run-1");
		expect(listed.ok && listed.value.map((q) => q.questionId)).toEqual([
			questionId,
		]);

		const answered = await Loop.answer(
			{ home, basePath: home, actor: HUMAN },
			questionId,
			"2",
		);
		expect(answered.ok && answered.value.answer).toBe("Reject");
		const activities = await Planner.getActivities(home, sessionId);
		const decision =
			activities.ok && activities.value.find((a) => a.type === "decision");
		expect(decision && decision.body).toBe("Reject");
		const inbox = RunStore.readInbox(home, "run-1", 0);
		expect(inbox.ok && inbox.value.entries).toMatchObject([
			{ kind: "answered", questionId, by: HUMAN },
		]);
		const after = await Loop.questions({ basePath: home }, "run-1");
		expect(after.ok && after.value).toEqual([]);
	});

	it("refuses an answer that is none of the harness's options, and answers nothing", async () => {
		const { sessionId, questionId } = await blocked("run-1");
		const answered = await Loop.answer(
			{ home, basePath: home, actor: HUMAN },
			questionId,
			"yes please",
		);
		expect(answered.ok).toBe(false);
		const activities = await Planner.getActivities(home, sessionId);
		expect(
			activities.ok && activities.value.some((a) => a.type === "decision"),
		).toBe(false);
	});
});
