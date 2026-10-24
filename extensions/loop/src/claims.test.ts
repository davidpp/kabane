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
		const a = await add("a", {
			parentTaskId: parent.id,
			state: "in_progress",
			assignee: "claude",
		});
		const b = await add("b", {
			parentTaskId: parent.id,
			state: "done",
			assignee: "claude",
		});
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

describe("Claims parking and ownership", () => {
	for (const recover of [false, true]) {
		for (const change of [
			{ state: "waiting" },
			{ state: "someday" },
			{ kind: "task" },
			{ assignee: "owner" },
			{},
		] as const) {
			it(`${recover ? "recover" : "settle"} respects ${JSON.stringify(change)} without erasing earlier failed attempts`, async () => {
				const parent = await add("parent");
				const child = await add("child", {
					parentTaskId: parent.id,
					state: "in_progress",
					assignee: "claude",
				});
				const sessionId = await sessionOn(child);
				const config = LoopConfig.Schema.safeParse({ stallAfter: 2 });
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
					claims: [claimOf(child, sessionId)],
					usage: {},
					continuationsUsed: 0,
					inboxRead: 0,
					steering: Steering.INITIAL,
					gateRuns: [],
				};
				const created = RunStore.create(home, run);
				if (!created.ok) throw created.error;
				const ctx = ctxFor(run);
				const plan = await LoopPlan.load(home, parent.id);
				if (!plan.ok) throw plan.error;
				ctx.run.stall = {
					mark: await Claims.mark(ctx, plan.value),
					unchanged: 1,
				};
				const changed = await Planner.updateTask(home, child.id, change);
				if (!changed.ok || !changed.value)
					throw new Error("task update failed");
				const active = Object.keys(change).length === 0;
				if (recover) await Claims.recover(ctx);
				else
					expect(
						await Claims.settle(ctx, {
							taskId: child.id,
							sessionId,
							outcome: { outcome: "incomplete" },
						}),
					).toBe(active);
				const after = await Planner.getTask(home, child.id);
				if (!after.ok || !after.value) throw new Error("missing task");
				expect(after.value.state).toBe(active ? "next" : changed.value.state);
				expect(after.value.kind).toBe(changed.value.kind);
				expect(after.value.assignee).toBe(changed.value.assignee);
				expect(ctx.run.stall?.unchanged).toBe(active && !recover ? 2 : 1);
				const session = await Planner.getSession(home, sessionId);
				if (!session.ok || !session.value) throw new Error("missing session");
				expect(session.value.state).not.toBe("active");
			});
		}
	}
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
	for (const change of [
		{ kind: "task" },
		{ state: "waiting" },
		{ state: "someday" },
		{ deferUntil: "2999-01-01T00:00:00.000Z" },
		{ parentTaskId: null },
	] as const) {
		it(`does not acquire a stale candidate after ${JSON.stringify(change)}`, async () => {
			const parent = await add("parent");
			const child = await add("child", {
				parentTaskId: parent.id,
				assignee: "owner",
			});
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
				claims: [],
				usage: {},
				continuationsUsed: 0,
				inboxRead: 0,
				steering: Steering.INITIAL,
				gateRuns: [],
			};
			const created = RunStore.create(home, run);
			if (!created.ok) throw created.error;
			const plan = await LoopPlan.load(home, parent.id);
			if (!plan.ok) throw plan.error;
			const node = plan.value.nodes[0];
			if (!node) throw new Error("missing child");
			const changed = await Planner.updateTask(home, child.id, change);
			if (!changed.ok) throw changed.error;
			const ctx = ctxFor(run);
			ctx.deps = {
				...ctx.deps,
				overrides: { claude: { command: "/nonexistent/harness" } },
			};
			await Claims.claim(ctx, node, plan.value);
			expect(ctx.run.claims).toEqual([]);
			expect(ctx.live.size).toBe(0);
			const after = await Planner.getTask(home, child.id);
			expect(after.ok && after.value).toEqual(changed.value);
			const sessions = await Planner.querySessions(home, { taskId: child.id });
			expect(sessions.ok && sessions.value).toEqual([]);
		});
	}
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
