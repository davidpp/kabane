// Settling ended sessions against a real tracker: the core sessions, the subtasks' states and the
// gate results a settle records.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@cabane/core";
import { Claims } from "./claims";
import { LoopConfig } from "./config";
import type { Gates } from "./gates";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import type { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-claims-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const add = async (
	title: string,
	extra: Record<string, unknown> = {},
): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const sessionOn = async (task: Task): Promise<string> => {
	const session = await Planner.startSession(home, {
		taskId: task.id,
		agent: "claude",
		externalRef: RunStore.sessionRef("run-1"),
	});
	if (!session.ok) throw session.error;
	return session.value.id;
};

const claimOf = (task: Task, sessionId: string): RunStore.Claim => ({
	taskId: task.id,
	shortId: task.shortId ?? task.id,
	harness: "claude",
	lane: `claude:${task.shortId}`,
	sessionId,
	startedAt: new Date().toISOString(),
	continuations: 0,
});

const ctxFor = (run: RunStore.Run): RunState.Ctx => {
	const log = RunStore.eventLog(home, run.id);
	if (!log.ok) throw log.error;
	return {
		deps: {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
		},
		now: () => new Date(),
		tree: async () => "tree",
		log: log.value,
		run,
		live: new Map(),
		settled: [],
		wake: () => {},
		stopRequested: false,
		stopping: new AbortController(),
		gating: Promise.resolve(),
	};
};

describe("Claims.settleAll", () => {
	it("settles the whole batch even when its first session trips the stall", async () => {
		const parent = await add("parent");
		const a = await add("a", { parentTaskId: parent.id, state: "in_progress" });
		const b = await add("b", { parentTaskId: parent.id, state: "done" });
		const [sa, sb] = [await sessionOn(a), await sessionOn(b)];
		// b's session closed it, and the gates its end ran came back red.
		const red: Gates.Run = {
			at: new Date().toISOString(),
			taskId: b.id,
			results: [
				{
					name: "test",
					command: "exit 1",
					ok: false,
					exit: 1,
					ms: 5,
					tail: "1 failed",
				},
			],
			ok: false,
			tree: "tree",
		};
		const config = LoopConfig.Schema.safeParse({ stallAfter: 1 });
		if (!config.success) throw config.error;
		const run: RunStore.Run = {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: home,
			config: config.data,
			status: "running",
			createdAt: new Date().toISOString(),
			claims: [claimOf(a, sa), claimOf(b, sb)],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [red],
		};
		const created = RunStore.create(home, run);
		if (!created.ok) throw created.error;
		const ctx = ctxFor(run);
		const plan = await LoopPlan.load(home, parent.id);
		if (!plan.ok) throw plan.error;
		// The mark as it stands: a's end changes nothing, so it alone reaches `stallAfter: 1`.
		ctx.run = {
			...ctx.run,
			stall: Stall.start(await Claims.mark(ctx, plan.value)),
		};
		ctx.settled.push(
			{
				taskId: a.id,
				sessionId: sa,
				outcome: { outcome: "error", detail: "a broke" },
			},
			{
				taskId: b.id,
				sessionId: sb,
				outcome: { outcome: "done", detail: "b is done" },
				gates: red,
			},
		);

		expect(await Claims.settleAll(ctx)).toBe(true);

		expect(ctx.settled).toEqual([]);
		expect(
			ctx.run.claims.map((c) => [c.sessionId, c.outcome, c.detail]),
		).toEqual([
			[sa, "error", "a broke"],
			[sb, "done", "b is done"],
		]);
		// b's red gate reopened it, as it does for a session that ends alone.
		const reopened = await Planner.getTask(home, b.id);
		expect(reopened.ok && reopened.value?.state).toBe("next");
		for (const id of [sa, sb]) {
			const session = await Planner.getSession(home, id);
			expect(session.ok && session.value?.state).not.toBe("active");
		}
	});
});

describe("Claims.hooks", () => {
	it("records a relayed permission request on the asking claim's lane, session and task", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "in_progress",
		});
		const sessionId = await sessionOn(child);
		const claim = claimOf(child, sessionId);
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		const run: RunStore.Run = {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: home,
			config: config.data,
			status: "running",
			createdAt: new Date().toISOString(),
			claims: [claim],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		};
		const created = RunStore.create(home, run);
		if (!created.ok) throw created.error;
		const hooks = Claims.hooks(
			ctxFor(run),
			sessionId,
			claim.lane,
			claim.shortId,
			"claude",
		);
		const relayed = hooks.permission(
			{
				toolCallId: "toolu_01",
				title: "bun install",
				options: [
					{ id: "allow", name: "Yes", kind: "allow_once" },
					{ id: "reject", name: "No", kind: "reject_once" },
				],
			},
			new AbortController().signal,
		);
		let questionId: string | undefined;
		for (let i = 0; i < 200 && !questionId; i++) {
			const needs = await Planner.getNeedsInput(home);
			if (!needs.ok) throw needs.error;
			questionId = needs.value.find((r) => r.session.id === sessionId)?.question
				?.id;
			if (!questionId) await Bun.sleep(5);
		}
		if (!questionId) throw new Error("no question appeared");
		const answered = await Planner.answerQuestion(home, {
			questionId,
			answer: "Yes",
		});
		if (!answered.ok) throw answered.error;
		const chosen = await relayed;
		expect(chosen.ok && chosen.value).toBe("allow");

		const events = RunStore.readEvents(home, run.id);
		if (!events.ok) throw events.error;
		const permission = events.value.filter((e) =>
			e.type.startsWith("permission_"),
		);
		expect(permission.map((e) => [e.type, e.lane, e.session, e.task])).toEqual([
			["permission_asked", claim.lane, sessionId, claim.shortId],
			["permission_answered", claim.lane, sessionId, claim.shortId],
		]);
	});
});

describe("Claims.claim", () => {
	it("works a subtask on the run's harness and makes it the assignee, whoever filed it", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			assignee: "claude",
		});
		const config = LoopConfig.Schema.safeParse({ implementer: "codex" });
		if (!config.success) throw config.error;
		const run: RunStore.Run = {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: home,
			config: config.data,
			status: "running",
			createdAt: new Date().toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		};
		const created = RunStore.create(home, run);
		if (!created.ok) throw created.error;
		const ctx = ctxFor(run);
		// Every harness fails at once, so no real session starts: what is under test is who the
		// claim gave the subtask to.
		const fails = { command: "/usr/bin/false", args: [] };
		ctx.deps = {
			...ctx.deps,
			overrides: { claude: fails, codex: fails, gemini: fails },
		};
		const plan = await LoopPlan.load(home, parent.id);
		if (!plan.ok) throw plan.error;
		const node = plan.value.nodes.find((n) => n.task.id === child.id);
		if (!node) throw new Error("child is not in the plan");

		await Claims.claim(ctx, node, plan.value);
		await Promise.all([...ctx.live.values()].map((l) => l.settled));

		expect(ctx.run.claims.map((c) => c.harness)).toEqual(["codex"]);
		const task = await Planner.getTask(home, child.id);
		expect(task.ok && task.value?.assignee).toBe("codex");
	});
});
