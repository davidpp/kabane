// A claim's life in the tracker: open a core session on the subtask, move it to in_progress,
// log the session on it, dispatch; when the session ends, close the core session, put a
// subtask the agent left in progress back in the ready pool, and take a progress mark for the
// stall detector. A runner that died mid-claim leaves claims with no end; `recover` closes them.
import { err, Planner } from "@cabane/core";
import { Budget } from "./budget";
import { Dispatch } from "./dispatch";
import { LoopPlan } from "./plan";
import { Scheduler } from "./scheduler";
import { Stall } from "./stall";
import { RunState } from "./state";
import { RunStore } from "./store";

export namespace Claims {
	type Ctx = RunState.Ctx;

	const label = (task: { shortId?: string; id: string }): string =>
		task.shortId ?? task.id;

	// A subtask left in_progress by a claim that is over goes back to the ready pool. One the
	// agent moved elsewhere (done, waiting) keeps the state it was given.
	const release = async (ctx: Ctx, taskId: string): Promise<void> => {
		const task = await Planner.getTask(ctx.deps.basePath, taskId);
		if (!task.ok || task.value?.state !== "in_progress") return;
		const reset = await Planner.updateTask(ctx.deps.basePath, taskId, {
			state: "next",
		});
		if (!reset.ok)
			RunState.event(ctx, {
				type: "warning",
				summary: `${taskId} not released: ${reset.error.message}`,
			});
	};

	const closeSession = async (
		ctx: Ctx,
		sessionId: string,
		outcome: Dispatch.Outcome,
	): Promise<void> => {
		const finished =
			outcome.outcome === "done" || outcome.outcome === "incomplete";
		const summary = outcome.summary ?? outcome.detail;
		const ended = await Planner.endSession(ctx.deps.basePath, sessionId, {
			state: finished ? "complete" : "error",
			...(summary ? { summary } : {}),
		});
		if (!ended.ok)
			RunState.event(ctx, {
				type: "warning",
				session: sessionId,
				summary: `session not closed: ${ended.error.message}`,
			});
	};

	export const mark = (ctx: Ctx, plan: LoopPlan.Plan): string =>
		Stall.mark(
			LoopPlan.closedWork(plan),
			ctx.tree(RunStore.sessionDir(ctx.run)),
		);

	/** Close the claims a runner that died left open. */
	export const recover = async (ctx: Ctx): Promise<void> => {
		const open = ctx.run.claims.filter((c) => c.endedAt === undefined);
		for (const claim of open) {
			const detail = "the runner exited while this session was open";
			await closeSession(ctx, claim.sessionId, { outcome: "error", detail });
			await release(ctx, claim.taskId);
			RunState.patchClaim(ctx, claim.sessionId, {
				endedAt: ctx.now().toISOString(),
				outcome: "interrupted",
				detail,
			});
			RunState.event(ctx, {
				type: "session_end",
				lane: claim.lane,
				session: claim.sessionId,
				task: claim.shortId,
				summary: `interrupted: ${detail}`,
			});
		}
	};

	const hooks = (
		ctx: Ctx,
		sessionId: string,
		lane: string,
		shortId: string,
	): Dispatch.Hooks => ({
		event: (draft) => RunState.event(ctx, draft),
		usage: (usage) =>
			RunState.save(ctx, {
				...ctx.run,
				usage: Budget.record(ctx.run.usage, sessionId, usage),
			}),
		continueTurn: () => {
			const budget = ctx.run.config.budget;
			if (
				ctx.stopRequested ||
				!Budget.canContinue(budget, ctx.run.continuationsUsed)
			)
				return false;
			RunState.save(ctx, {
				...ctx.run,
				continuationsUsed: ctx.run.continuationsUsed + 1,
				claims: ctx.run.claims.map((c) =>
					c.sessionId === sessionId
						? { ...c, continuations: c.continuations + 1 }
						: c,
				),
			});
			return true;
		},
		// Questions and permissions reach a human with the steering package. Until then a
		// request is declined, never answered on the human's behalf, and the decline is traced.
		permission: async (request) => {
			RunState.event(ctx, {
				type: "permission",
				lane,
				session: sessionId,
				task: shortId,
				summary: `declined: ${request.title}`,
			});
			return err(
				new Error("declined: the loop does not answer permission requests yet"),
			);
		},
	});

	// Open the core session and mark the subtask as taken; the session id, or undefined.
	const open = async (
		ctx: Ctx,
		node: LoopPlan.Node,
		harness: string,
		lane: string,
	): Promise<string | undefined> => {
		const task = node.task;
		const tag = { lane, task: label(task) };
		const session = await Planner.startSession(ctx.deps.basePath, {
			taskId: task.id,
			agent: harness,
			externalRef: `loop:${ctx.run.id}`,
		});
		if (!session.ok) {
			RunState.event(ctx, {
				...tag,
				type: "error",
				summary: `session not started: ${session.error.message}`,
			});
			return undefined;
		}
		const sessionId = session.value.id;
		const moved = await Planner.updateTask(ctx.deps.basePath, task.id, {
			state: "in_progress",
		});
		if (!moved.ok)
			RunState.event(ctx, {
				...tag,
				type: "warning",
				summary: `not moved to in_progress: ${moved.error.message}`,
			});
		const logged = await Planner.addWorkLog(ctx.deps.basePath, {
			taskId: task.id,
			refs: [{ uri: `session:${sessionId}`, label: `loop ${ctx.run.id}` }],
			addedBy: `loop:${ctx.run.id}`,
			addedByType: "ai",
		});
		if (!logged.ok)
			RunState.event(ctx, {
				...tag,
				type: "warning",
				summary: `work log not written: ${logged.error.message}`,
			});
		return sessionId;
	};

	/** Claim one ready subtask: a core session, a dispatched ACP session, a live entry. */
	export const claim = async (
		ctx: Ctx,
		node: LoopPlan.Node,
		plan: LoopPlan.Plan,
	): Promise<void> => {
		const task = node.task;
		const harness = Scheduler.harnessFor(node, ctx.run.config.implementer);
		const attempts = ctx.run.claims.filter((c) => c.taskId === task.id).length;
		const lane = `${harness}:${label(task)}${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, node, harness, lane);
		if (sessionId === undefined) return;
		RunState.save(ctx, {
			...ctx.run,
			claims: [
				...ctx.run.claims,
				{
					taskId: task.id,
					shortId: label(task),
					harness,
					lane,
					sessionId,
					startedAt: ctx.now().toISOString(),
					continuations: 0,
				},
			],
		});
		RunState.event(ctx, {
			type: "claim",
			lane,
			session: sessionId,
			task: label(task),
			summary: `${harness} claims ${label(task)}: ${task.title}`,
		});
		const model = ctx.run.config.model;
		const handle = Dispatch.begin(
			{ parent: plan.parent, task, harness, sessionId, lane },
			{
				basePath: ctx.deps.basePath,
				home: ctx.deps.home,
				kabaneBin: ctx.deps.kabaneBin,
				cwd: RunStore.sessionDir(ctx.run),
				runId: ctx.run.id,
				...(ctx.run.scopeUri ? { scopeUri: ctx.run.scopeUri } : {}),
				overrides: {
					...ctx.deps.overrides?.[harness],
					...(model ? { model } : {}),
				},
			},
			hooks(ctx, sessionId, lane, label(task)),
		);
		ctx.live.set(task.id, { sessionId, handle });
		void handle.done.then((outcome) => {
			ctx.settled.push({ taskId: task.id, sessionId, outcome });
			ctx.wake();
		});
	};

	/** Close the books on one ended session; true when the run has stalled. */
	export const settle = async (
		ctx: Ctx,
		{ taskId, sessionId, outcome }: RunState.Settled,
	): Promise<boolean> => {
		ctx.live.delete(taskId);
		await closeSession(ctx, sessionId, outcome);
		await release(ctx, taskId);
		RunState.patchClaim(ctx, sessionId, {
			endedAt: ctx.now().toISOString(),
			outcome: outcome.outcome,
			...(outcome.detail ? { detail: outcome.detail } : {}),
		});
		const ended = ctx.run.claims.find((c) => c.sessionId === sessionId);
		RunState.event(ctx, {
			type: "session_end",
			...(ended ? { lane: ended.lane, task: ended.shortId } : {}),
			session: sessionId,
			summary: `${outcome.outcome}${outcome.detail ? `: ${outcome.detail}` : ""}`,
		});
		const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		if (!plan.ok) return false;
		const stall = Stall.observe(
			ctx.run.stall ?? Stall.start(""),
			mark(ctx, plan.value),
		);
		RunState.save(ctx, { ...ctx.run, stall });
		return Stall.stalled(stall, ctx.run.config.stallAfter);
	};
}
