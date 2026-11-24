import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// Settling ended sessions against a real tracker: the core sessions, the subtasks' states and the
// gate results a settle records.
import "@kabane/core/testing";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "@kabane/acp";
import { Planner, type Task, withDb } from "@kabane/core";
import { Claims } from "./claims";
import { LoopConfig } from "./config";
import type { Gates } from "./gates";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import type { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { TestHarnesses } from "./test-harnesses";
import { testHost } from "./test-host";
import { TestSessions } from "./test-sessions";

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
			host: testHost(home),
			kabaneBin: () => "/nonexistent/kabane",
			pid: process.pid,
			overrides: TestHarnesses.overrides(),
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
		const [sa, sb] = [RunStore.newSessionId(), RunStore.newSessionId()];
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
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
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
				outcome: {
					outcome: "done",
					detail: "b is done",
					summary: "Finished b and checked its result",
				},
				gates: red,
			},
		);

		expect(await Claims.settleAll(ctx)).toBe(true);

		expect(ctx.settled).toEqual([]);
		const noSummary = await Planner.getEntries(home, a.id);
		expect(
			noSummary.ok &&
				noSummary.value.filter((c) => c.kind === "outcome.summary"),
		).toEqual([]);
		const summaries = await Planner.getEntries(home, b.id);
		expect(
			summaries.ok &&
				summaries.value.some(
					(c) =>
						c.kind === "outcome.summary" &&
						c.content === "Finished b and checked its result",
				),
		).toBe(true);
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
			expect(
				ctx.run.claims.find((c) => c.sessionId === id)?.endedAt,
			).toBeDefined();
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
				const sessionId = RunStore.newSessionId();
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
				const plan = await LoopPlan.load(testHost(home).record, parent.id);
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
				expect(
					ctx.run.claims.find((c) => c.sessionId === sessionId)?.endedAt,
				).toBeDefined();
			});
		}
	}
});

describe("Claims.hooks", () => {
	it("relays the scripted agent's permission through the real run journal and answers it over ACP", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			state: "in_progress",
		});
		const sessionId = RunStore.newSessionId();
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
		const launch = TestHarnesses.overrides({
			claude: {
				command: process.execPath,
				args: [
					join(
						import.meta.dir,
						"../../../packages/acp/scripts/scripted-agent.ts",
					),
				],
			},
		}).claude;
		if (!launch) throw new Error("missing scripted launch");
		const stopped = new AbortController();
		const connection = await AcpClient.spawn("claude", home, {
			overrides: launch,
			onPermission: (request, withdrawn) =>
				hooks.permission(request, withdrawn, stopped.signal),
			onElicitation: (request, withdrawn) =>
				hooks.elicitation(request, withdrawn, stopped.signal),
		});
		if (!connection.ok) throw connection.error;
		try {
			const session = await AcpClient.newSession(connection.value, {
				cwd: home,
				mcpServers: [],
			});
			if (!session.ok) throw session.error;
			const text: string[] = [];
			const prompted = (async () => {
				for await (const update of AcpClient.prompt(session.value, [
					{ type: "text", text: "ask permission" },
				]))
					if (update.type === "text") text.push(update.text);
			})();
			let questionId: string | undefined;
			for (let i = 0; i < 200 && !questionId; i++) {
				const needs = await TestSessions.pending(home);
				if (!needs.ok) throw needs.error;
				questionId = needs.value.find((r) => r.session.id === sessionId)
					?.question.id;
				if (!questionId) await Bun.sleep(5);
			}
			if (!questionId)
				throw new Error("scripted permission question did not appear");
			const answer = await TestSessions.submit(home, {
				questionId,
				answer: "Allow once",
			});
			if (!answer.ok) throw answer.error;
			await prompted;
			expect(text.join("")).toContain("Received: allow");
		} finally {
			stopped.abort();
			await AcpClient.close(connection.value);
			await connection.value.closed;
		}

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
			const plan = await LoopPlan.load(testHost(home).record, parent.id);
			if (!plan.ok) throw plan.error;
			const node = plan.value.nodes[0];
			if (!node) throw new Error("missing child");
			const changed = await Planner.updateTask(home, child.id, change);
			if (!changed.ok) throw changed.error;
			const ctx = ctxFor(run);
			ctx.deps = {
				...ctx.deps,
				overrides: TestHarnesses.overrides({
					claude: { command: "/nonexistent/harness" },
				}),
			};
			await Claims.claim(ctx, node, plan.value);
			expect(ctx.run.claims).toEqual([]);
			expect(ctx.live.size).toBe(0);
			const after = await Planner.getTask(home, child.id);
			expect(after.ok && after.value).toEqual(changed.value);
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
			overrides: TestHarnesses.overrides({
				claude: fails,
				codex: fails,
				gemini: fails,
			}),
		};
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;
		const node = plan.value.nodes.find((n) => n.task.id === child.id);
		if (!node) throw new Error("child is not in the plan");

		await Claims.claim(ctx, node, plan.value);
		await Promise.all([...ctx.live.values()].map((l) => l.settled));

		expect(ctx.run.claims.map((c) => c.harness)).toEqual(["codex"]);
		const logs = await Planner.getWorkLogs(home, child.id);
		expect(
			logs.ok && logs.value.flatMap((log) => log.refs.map((ref) => ref.uri)),
		).toContain(`session:${ctx.run.claims[0]?.sessionId}`);
		const task = await Planner.getTask(home, child.id);
		expect(task.ok && task.value?.assignee).toBe("codex");
	});

	it("runs a subtask on the harness its tier tag pins, and notes the tags it cannot honour", async () => {
		const parent = await add("parent");
		const pinned = await add("pinned", {
			parentTaskId: parent.id,
			tags: ["tier:codex/fast", "agent:board-ui"],
		});
		const bad = await add("bad", {
			parentTaskId: parent.id,
			tags: ["tier:cobol/fast", "tier:fast"],
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
		const ctx = ctxFor(run);
		const fails = { command: "/usr/bin/false", args: [] };
		ctx.deps = {
			...ctx.deps,
			overrides: TestHarnesses.overrides({
				claude: fails,
				codex: fails,
				gemini: fails,
			}),
		};
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;
		for (const task of [pinned, bad]) {
			const node = plan.value.nodes.find((n) => n.task.id === task.id);
			if (!node) throw new Error(`${task.title} is not in the plan`);
			await Claims.claim(ctx, node, plan.value);
		}
		await Promise.all([...ctx.live.values()].map((l) => l.settled));

		expect(ctx.run.claims.map((c) => [c.taskId, c.harness])).toEqual([
			[pinned.id, "codex"],
			[bad.id, "claude"],
		]);
		const assigned = await Planner.getTask(home, pinned.id);
		expect(assigned.ok && assigned.value?.assignee).toBe("codex");
		const events = RunStore.readEvents(home, run.id);
		if (!events.ok) throw events.error;
		const said = events.value.map((e) => e.summary);
		expect(said).toContain(
			`codex as board-ui at tier fast claims ${pinned.shortId}: pinned`,
		);
		expect(said).toContain(
			"tier:cobol/fast: cobol is not a harness (claude, codex, gemini), so it runs on claude",
		);
		expect(said).toContain("tier:fast ignored: the first tag of its kind wins");
	});

	// The order of precedence is LoopConfig.launchOverrides's, tested on its own (config.test.ts);
	// this is that a claim launches what it says, its runner's own overrides first. Every harness
	// in the run's stored setting is a command no machine has, so a claim that stopped consulting
	// the runner's overrides fails this by assertion and reaches no adapter.
	it("launches the runner's own overrides over the run's stored setting", async () => {
		const parent = await add("parent");
		const child = await add("child", { parentTaskId: parent.id });
		const nowhere = { command: "/nonexistent/harness", args: ["setting"] };
		const config = LoopConfig.Schema.safeParse({
			implementer: "gemini",
			harnesses: { claude: nowhere, codex: nowhere, gemini: nowhere },
		});
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
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;
		const node = plan.value.nodes.find((n) => n.task.id === child.id);
		if (!node) throw new Error("child is not in the plan");
		const ctx = ctxFor(run);
		// It fails at once, so no session starts: what is under test is what the claim launched.
		ctx.deps = {
			...ctx.deps,
			overrides: TestHarnesses.overrides({
				gemini: { command: "/usr/bin/false", args: ["deps"] },
			}),
		};

		await Claims.claim(ctx, node, plan.value);
		await Promise.all([...ctx.live.values()].map((l) => l.settled));

		const events = RunStore.readEvents(home, run.id);
		if (!events.ok) throw events.error;
		expect(
			events.value
				.filter((e) => e.type === "launch")
				.map((e) => e.summary.split(" · ")[0]),
		).toEqual(["/usr/bin/false deps"]);
	});
});

describe("Claims.claim, when another agent holds the claim", () => {
	it("launches nothing after its edit names another holder", async () => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			assignee: "claude",
		});
		// Another device's claim, made offline first, arrived before this run's edit.
		const placed = await withDb(home, (db) =>
			db.run(
				`INSERT INTO entries (id, thread_id, kind, author, created_at, created_device, version, visibility)
				 VALUES ('01KCLAIMOTHER0000000000000', ?, 'claim', 'kabane://actor/agent/codex', '2026-01-01T00:00:00.000Z', 'elsewhere', 1, 'shared')`,
				[child.id],
			),
		);
		if (!placed.ok) throw placed.error;
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
		const ctx = ctxFor(run);
		const fails = { command: "/usr/bin/false", args: [] };
		ctx.deps = {
			...ctx.deps,
			overrides: TestHarnesses.overrides({ claude: fails, codex: fails }),
		};
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;
		const node = plan.value.nodes.find((n) => n.task.id === child.id);
		if (!node) throw new Error("child is not in the plan");

		await Claims.claim(ctx, node, plan.value);

		expect(ctx.run.claims).toEqual([]);
		expect(ctx.live.size).toBe(0);
	});
});

describe("Claims.claim, resuming an attempt's session", () => {
	// A subtask whose last attempt ran on codex as `kabane-test` at tier fast, its tags since
	// changed to route it elsewhere, claimed again on a run whose harnesses all fail at once.
	let runs = 0;
	const reclaim = async (
		attempt: Partial<RunStore.Claim>,
		extra: (child: Task) => Partial<RunStore.Run> = () => ({}),
	) => {
		const parent = await add("parent");
		const child = await add("child", {
			parentTaskId: parent.id,
			tags: ["tier:claude/frontier", "agent:board-ui"],
		});
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		const previous: RunStore.Claim = {
			...claimOf(child, "s-old"),
			harness: "codex",
			lane: child.shortId ?? child.id,
			acpSessionId: "codex-thread-1",
			agent: "kabane-test",
			model: "gpt-6-luna",
			modelSource: "tier",
			tier: "fast",
			endedAt: new Date().toISOString(),
			...attempt,
		};
		runs += 1;
		const run: RunStore.Run = {
			version: 1,
			id: `run-${runs}`,
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: home,
			config: config.data,
			status: "running",
			createdAt: new Date().toISOString(),
			claims: [previous],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
			...extra(child),
		};
		const created = RunStore.create(home, run);
		if (!created.ok) throw created.error;
		const ctx = ctxFor(run);
		const fails = { command: "/usr/bin/false", args: [] };
		ctx.deps = {
			...ctx.deps,
			overrides: TestHarnesses.overrides({
				claude: fails,
				codex: fails,
				gemini: fails,
			}),
		};
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;
		const node = plan.value.nodes.find((n) => n.task.id === child.id);
		if (!node) throw new Error("child is not in the plan");
		await Claims.claim(ctx, node, plan.value);
		await Promise.all([...ctx.live.values()].map((l) => l.settled));
		const events = RunStore.readEvents(home, run.id);
		if (!events.ok) throw events.error;
		return {
			child,
			claim: ctx.run.claims[1],
			said: events.value.map((e) => e.summary),
		};
	};

	it("takes over an interrupted session on the harness, agent and tier it ran with, whatever the tags say now", async () => {
		const { child, claim, said } = await reclaim({ outcome: "interrupted" });
		expect(claim?.harness).toBe("codex");
		const lane = child.shortId ?? child.id;
		expect(said).toContain(
			`codex as kabane-test at tier fast claims ${lane}: child`,
		);
		expect(said).toContain(
			`${lane}'s session is resumed as it ran (codex as kabane-test at tier fast); the tags (claude as board-ui at tier frontier) route a fresh session`,
		);
	});

	it("continues a gate retry's session as it ran, too, and routes a fresh retry by the tags", async () => {
		const red = (child: Task): Gates.Run => ({
			at: new Date().toISOString(),
			taskId: child.id,
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
		});
		const roomy = await reclaim({ outcome: "done" }, (child) => ({
			usage: { "s-old": { used: 10, size: 100 } },
			gateRuns: [red(child)],
		}));
		expect(roomy.claim?.harness).toBe("codex");
		expect(
			roomy.said.some((s) =>
				s.startsWith("codex as kabane-test at tier fast claims"),
			),
		).toBe(true);
		// Past half its window, the retry starts fresh: the tags route it.
		const full = await reclaim({ outcome: "done" }, (child) => ({
			usage: { "s-old": { used: 90, size: 100 } },
			gateRuns: [red(child)],
		}));
		expect(full.claim?.harness).toBe("claude");
		expect(
			full.said.some((s) =>
				s.startsWith("claude as board-ui at tier frontier claims"),
			),
		).toBe(true);
	});

	it("routes by the tags when the last attempt left no session to resume", async () => {
		const { claim, said } = await reclaim({
			outcome: "interrupted",
			acpSessionId: undefined,
		});
		expect(claim?.harness).toBe("claude");
		expect(said.some((s) => s.includes("is resumed as it ran"))).toBe(false);
	});
});

describe("Claims.interruption", () => {
	it("keeps a dead runner's explanation in the run store without publishing a summary", async () => {
		const parent = await add("parent");
		const sessionId = RunStore.newSessionId();
		const ctx = runOn(parent, [
			{ ...claimOf(parent, sessionId), lenses: ["quality"] },
		]);
		expect(RunStore.create(home, ctx.run).ok).toBe(true);
		await Claims.recover(ctx);
		const stored = RunStore.readRaw(home, ctx.run.id);
		expect(stored.ok && stored.value.claims[0]?.detail).toBe(
			"the runner exited while this session was open",
		);
		const comments = await Planner.getEntries(home, parent.id);
		expect(
			comments.ok && comments.value.filter((c) => c.kind === "outcome.summary"),
		).toEqual([]);
	});

	// A real repository: one commit from before the attempt, one it made, and a file it left.
	const repo = (): string => {
		const dir = join(home, "project");
		mkdirSync(dir);
		const git = (args: string[], date?: string) => {
			const ran = Bun.spawnSync(
				[
					"git",
					"-C",
					dir,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"core.hooksPath=/dev/null",
					...args,
				],
				{
					env: {
						...process.env,
						...(date ? { GIT_COMMITTER_DATE: date } : {}),
					},
				},
			);
			if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
		};
		git(["init", "-q"]);
		git(
			["commit", "-q", "--allow-empty", "-m", "before"],
			"2020-01-01T00:00:00Z",
		);
		git(["commit", "-q", "--allow-empty", "-m", "during"]);
		writeFileSync(join(dir, "hello.txt"), "hi\n");
		return dir;
	};

	const runOn = (parent: Task, claims: RunStore.Claim[]) => {
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		return ctxFor({
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo(),
			config: config.data,
			status: "running",
			createdAt: new Date().toISOString(),
			claims,
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
	};

	const log = async (taskId: string, uri: string, note?: string) => {
		const logged = await Planner.addWorkLog(home, {
			taskId,
			refs: [{ uri, label: "wip" }],
			...(note ? { note } : {}),
		});
		if (!logged.ok) throw logged.error;
	};

	it("is what an interrupted attempt left: its own logs, its commits and the tree", async () => {
		const parent = await add("parent");
		const child = await add("child", { parentTaskId: parent.id });
		await log(child.id, "file:older.txt");
		await Bun.sleep(5);
		const sessionId = RunStore.newSessionId();
		const previous: RunStore.Claim = {
			...claimOf(child, sessionId),
			acpSessionId: "acp-1",
			endedAt: new Date().toISOString(),
			outcome: "interrupted",
		};
		await Bun.sleep(5);
		// The loop's own record of the session is not the attempt's work.
		await log(child.id, `session:${sessionId}`);
		await log(child.id, "file:hello.txt", "started on it");
		const ctx = runOn(parent, [previous]);

		const interrupted = await Claims.interruption(ctx, previous);

		expect(interrupted).toMatchObject({
			lane: previous.lane,
			startedAt: previous.startedAt,
			acpSessionId: "acp-1",
			logged: ["file:hello.txt (wip): started on it"],
			status: "?? hello.txt",
		});
		expect(interrupted?.commits).toMatch(/^[0-9a-f]+ during$/);
	});

	it("is nothing after an attempt that ended on its own, or when there was none", async () => {
		const parent = await add("parent");
		const child = await add("child", { parentTaskId: parent.id });
		const ended: RunStore.Claim = {
			...claimOf(child, RunStore.newSessionId()),
			endedAt: new Date().toISOString(),
			outcome: "error",
		};
		const ctx = runOn(parent, [ended]);
		expect(await Claims.interruption(ctx, ended)).toBeUndefined();
		expect(await Claims.interruption(ctx, undefined)).toBeUndefined();
	});
});

describe("Claims.lens on a group", () => {
	// The launch points at no harness, so the session fails without reaching a model: what is under
	// test is the one claim the group makes and how its end reads for each of its lenses.
	it("runs the group as one claim, at the tier given, and its end is each lens's", async () => {
		const parent = await add("parent", { state: "in_progress" });
		const config = LoopConfig.Schema.safeParse({
			lenses: ["functional", "quality"],
			tiers: { claude: { fast: "sonnet" } },
		});
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
		ctx.deps = {
			...ctx.deps,
			overrides: TestHarnesses.overrides({
				claude: { command: "/nonexistent/harness" },
			}),
		};
		const plan = await LoopPlan.load(testHost(home).record, parent.id);
		if (!plan.ok) throw plan.error;

		const started = await Claims.lens(
			ctx,
			["functional", "quality"],
			plan.value,
			"fast",
		);
		expect(started.ok).toBe(true);
		expect(
			ctx.run.claims.map((c) => [c.lenses, c.lane, c.taskId, c.harness]),
		).toEqual([
			[
				["functional", "quality"],
				"functional+quality-lens",
				parent.id,
				"claude",
			],
		]);
		expect(Lenses.status(config.data.lenses, ctx.run.claims).running).toEqual([
			"functional",
			"quality",
		]);
		const events = RunStore.readEvents(home, run.id);
		if (!events.ok) throw events.error;
		expect(events.value.find((e) => e.type === "claim")?.summary).toBe(
			`claude at tier fast reviews ${parent.shortId} through the functional and quality lenses`,
		);

		await Promise.all([...ctx.live.values()].map((l) => l.settled));
		await Claims.settleAll(ctx);
		const ended = Lenses.status(config.data.lenses, ctx.run.claims);
		expect(ended.failed.map((f) => f.name)).toEqual(["functional", "quality"]);

		// The same group again, in whatever order, is its second attempt.
		await Claims.lens(ctx, ["quality", "functional"], plan.value);
		expect(ctx.run.claims.at(-1)?.lane).toBe("quality+functional-lens#2");
		await Promise.all([...ctx.live.values()].map((l) => l.settled));
		await Claims.settleAll(ctx);
	});
});

describe("Claims.greenPass", () => {
	const result = (name: string, ok: boolean): Gates.Result => ({
		name,
		command: `run ${name}`,
		ok,
		exit: ok ? 0 : 1,
		ms: 10,
		tail: "",
	});
	const pass = (results: Gates.Result[], tree = "tree"): Gates.Run => ({
		at: new Date().toISOString(),
		results,
		ok: results.every((r) => r.ok),
		tree,
	});
	// `ctxFor`'s tree is "tree": a pass left on it is on the tree as it is now. One run each.
	let runs = 0;
	const ctxWith = async (
		gates: Record<string, string>,
		gateRuns: Gates.Run[],
	): Promise<RunState.Ctx> => {
		const parent = await add("parent", { state: "in_progress" });
		const config = LoopConfig.Schema.safeParse({ gates });
		if (!config.success) throw config.error;
		const run: RunStore.Run = {
			version: 1,
			id: `run-${++runs}`,
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
			gateRuns,
		};
		const created = RunStore.create(home, run);
		if (!created.ok) throw created.error;
		return ctxFor(run);
	};
	const gates = { check: "run check", test: "run test" };
	const green = [result("check", true), result("test", true)];

	it("takes the latest pass when every gate passed on the tree as it is", async () => {
		const ctx = await ctxWith(gates, [
			pass([result("check", false)]),
			pass(green),
		]);
		expect(await Claims.greenPass(ctx)).toEqual(green);
	});

	it("takes none when the latest pass is red, stopped short, on another tree, or there are no gates", async () => {
		const red = [result("check", true), result("test", false)];
		for (const runs of [
			[pass(green), pass(red)],
			[pass([result("check", true)])],
			[pass(green, "earlier tree")],
			[],
		])
			expect(
				await Claims.greenPass(await ctxWith(gates, runs)),
			).toBeUndefined();
		expect(
			await Claims.greenPass(await ctxWith({}, [pass([])])),
		).toBeUndefined();
	});
});
