// A claim's life in the tracker: open a core session on the subtask, move it to in_progress,
// log the session on it, dispatch; when the session ends with the subtask done, run the gates
// while the claim still holds it; then close the core session, put a subtask the agent left in
// progress and still owned back in the ready pool, record the gates, and take a progress mark
// for the stall detector unless the tracker parked or handed off the work. A lens is a claim
// on the parent that leaves its state alone and has no gates. A runner that died mid-claim leaves claims with no end; `recover`
// closes them.
import type { Harnesses } from "@cabane/acp";
import { err, ok, Planner, type Result, type Task } from "@cabane/core";
import { Budget } from "./budget";
import { Checks } from "./checks";
import { Dispatch } from "./dispatch";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import { RunState } from "./state";
import { RunStore } from "./store";

export namespace Claims {
	type Ctx = RunState.Ctx;

	const label = (task: { shortId?: string; id: string }): string =>
		task.shortId ?? task.id;

	// Return only this claim's still-active issue to the pool. Parking, human work and live
	// ownership handoffs belong to the tracker, including when recovering a dead runner.
	const release = async (
		ctx: Ctx,
		taskId: string,
		harness: string,
	): Promise<void> => {
		const task = await Planner.getTask(ctx.deps.basePath, taskId);
		if (!task.ok || !task.value || !LoopPlan.isActive(task.value, harness))
			return;
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

	export const mark = async (ctx: Ctx, plan: LoopPlan.Plan): Promise<string> =>
		Stall.mark(
			LoopPlan.closedWork(plan),
			await ctx.tree(RunStore.sessionDir(ctx.run)),
			Gates.signature(ctx.run.gateRuns.at(-1)),
		);

	/** Close the claims a runner that died left open. */
	export const recover = async (ctx: Ctx): Promise<void> => {
		const open = ctx.run.claims.filter((c) => c.endedAt === undefined);
		for (const claim of open) {
			const detail = "the runner exited while this session was open";
			await closeSession(ctx, claim.sessionId, { outcome: "error", detail });
			if (claim.lens === undefined)
				await release(ctx, claim.taskId, claim.harness);
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

	/** Who the run's inbox says answered `questionId`; the latest note wins. */
	const answeredBy = (ctx: Ctx, questionId: string): string | undefined => {
		const inbox = RunStore.readInbox(ctx.deps.home, ctx.run.id, 0);
		if (!inbox.ok) return undefined;
		const note = inbox.value.entries.findLast(
			(e) => e.kind === "answered" && e.questionId === questionId,
		);
		return note?.kind === "answered" ? note.by : undefined;
	};

	/**
	 * What a claim's dispatch reports through. Everything it records about its session, a relayed
	 * permission request included, carries the claim's lane, session and task, so it shows on that
	 * agent's lane of the run's tab.
	 */
	export const hooks = (
		ctx: Ctx,
		sessionId: string,
		lane: string,
		shortId: string,
		harness: string,
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
		// Relayed to the human as a question on this claim's session; the loop never answers.
		// Other claims run on meanwhile; waiting never advances the stall count.
		permission: (request, signal) =>
			Permission.relay(
				{
					basePath: ctx.deps.basePath,
					sessionId,
					harness,
					origin: `The ${harness} session working on ${shortId} in loop ${ctx.run.id} is blocked on this tool call until it is answered.`,
					signal,
					emit: (draft) =>
						RunState.event(ctx, {
							...draft,
							lane,
							session: sessionId,
							task: shortId,
						}),
					answeredBy: (questionId) => answeredBy(ctx, questionId),
					now: ctx.now,
				},
				request,
			),
	});

	// Open the core session and, for a subtask it takes, mark it as taken; the session id, or
	// undefined.
	const open = async (
		ctx: Ctx,
		task: Task,
		harness: string,
		lane: string,
		takes: boolean,
	): Promise<string | undefined> => {
		const tag = { lane, task: label(task) };
		const session = await Planner.startSession(ctx.deps.basePath, {
			taskId: task.id,
			agent: harness,
			externalRef: RunStore.sessionRef(ctx.run.id),
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
		if (takes) {
			const moved = await Planner.updateTask(ctx.deps.basePath, task.id, {
				state: "in_progress",
				assignee: harness,
			});
			if (!moved.ok || !moved.value) {
				const detail = moved.ok ? "the task was deleted" : moved.error.message;
				RunState.event(ctx, {
					...tag,
					type: "warning",
					summary: `not moved to in_progress: ${detail}`,
				});
				await closeSession(ctx, sessionId, { outcome: "error", detail });
				return undefined;
			}
		}
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

	type Started = {
		task: Task;
		harness: Harnesses.Id;
		lane: string;
		sessionId: string;
		work: Dispatch.Work;
		/** What the trace says about it. */
		summary: string;
	};

	// Record the claim, dispatch its session and hold it live until it has settled.
	const launch = (ctx: Ctx, plan: LoopPlan.Plan, started: Started): void => {
		const { task, harness, lane, sessionId, work } = started;
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
					...(work.kind === "lens" ? { lens: work.name } : {}),
				},
			],
		});
		RunState.event(ctx, {
			type: "claim",
			lane,
			session: sessionId,
			task: label(task),
			summary: started.summary,
		});
		const model = ctx.run.config.model;
		const handle = Dispatch.begin(
			{ parent: plan.parent, task, harness, sessionId, lane, work },
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
			hooks(ctx, sessionId, lane, label(task), harness),
		);
		const settled = handle.done.then(async (outcome) => {
			const gates =
				work.kind === "implement"
					? await gatesAfter(ctx, outcome, {
							taskId: task.id,
							label: label(task),
							title: task.title,
							lane,
						})
					: undefined;
			ctx.settled.push({
				taskId: task.id,
				sessionId,
				outcome,
				...(gates ? { gates } : {}),
			});
			ctx.wake();
		});
		ctx.live.set(sessionId, { taskId: task.id, handle, settled });
	};

	/** Claim one ready subtask: a core session, a dispatched ACP session, a live entry. */
	export const claim = async (
		ctx: Ctx,
		node: LoopPlan.Node,
		plan: LoopPlan.Plan,
	): Promise<void> => {
		// The plan is a snapshot. Respect tracker changes before acquiring it; this is not
		// cross-process compare-and-swap ownership.
		const current = await Planner.getTask(ctx.deps.basePath, node.task.id);
		if (!current.ok) {
			RunState.event(ctx, {
				type: "warning",
				summary: `claim not read: ${current.error.message}`,
			});
			return;
		}
		const task = current.value;
		if (
			!task ||
			!LoopPlan.canClaim(task, ctx.now()) ||
			task.parentTaskId !== plan.parent.id ||
			!LoopPlan.isWork(LoopPlan.node(task, node.blockedBy))
		)
			return;
		// The run's harness, whatever the subtask's assignee says: agents assign issues they file
		// to themselves, so the assignee names who wrote it, not who the human picked to work it.
		const harness = ctx.run.config.implementer;
		const attempts = ctx.run.claims.filter((c) => c.taskId === task.id).length;
		// Named by the subtask alone: every subtask runs on the run's one harness, which the header names.
		const lane = `${label(task)}${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, task, harness, lane, true);
		if (sessionId === undefined) return;
		const retry = Gates.lastFailure(ctx.run.gateRuns, task.id);
		launch(ctx, plan, {
			task,
			harness,
			lane,
			sessionId,
			work: { kind: "implement", ...(retry ? { retry } : {}) },
			summary: `${harness} claims ${label(task)}: ${task.title}`,
		});
	};

	/**
	 * Run lens `name` on the parent, on the run's verifier harness. An error when its prompt
	 * cannot be read or its session cannot start.
	 */
	export const lens = async (
		ctx: Ctx,
		name: string,
		plan: LoopPlan.Plan,
	): Promise<Result<void>> => {
		const prompt = Lenses.prompt(ctx.run.projectDir, name);
		if (!prompt.ok) return prompt;
		const harness = ctx.run.config.verifier ?? ctx.run.config.implementer;
		const attempts = ctx.run.claims.filter((c) => c.lens === name).length;
		const lane = `${name}-lens${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(new Error(`the ${name} lens's session did not start`));
		launch(ctx, plan, {
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: { kind: "lens", name, prompt: prompt.value },
			summary: `${harness} reviews ${label(plan.parent)} through the ${name} lens`,
		});
		return ok(undefined);
	};

	// A session that closed its subtask as done is followed by the gates, while the claim still
	// holds the subtask, so nothing claims it again before its gates have spoken.
	const gatesAfter = async (
		ctx: Ctx,
		outcome: Dispatch.Outcome,
		subject: Checks.Subject & { taskId: string },
	) => {
		if (
			outcome.outcome !== "done" ||
			!Gates.configured(ctx.run.config.gates) ||
			ctx.stopping.signal.aborted
		)
			return undefined;
		const task = await Planner.getTask(ctx.deps.basePath, subject.taskId);
		if (!task.ok || task.value?.state !== "done") return undefined;
		return Checks.gate(ctx, subject);
	};

	/** Close the books on one ended session; true when the run has stalled. */
	export const settle = async (
		ctx: Ctx,
		{ taskId, sessionId, outcome, gates }: RunState.Settled,
	): Promise<boolean> => {
		ctx.live.delete(sessionId);
		const claim = ctx.run.claims.find((c) => c.sessionId === sessionId);
		const lens = claim?.lens !== undefined;
		await closeSession(ctx, sessionId, outcome);
		if (!lens && claim) await release(ctx, taskId, claim.harness);
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
		if (gates)
			await Checks.record(ctx, gates, {
				taskId,
				label: ended?.shortId ?? taskId,
				assignee: ended?.harness,
				...(ended ? { lane: ended.lane } : {}),
			});
		// A lens runs once per run and files findings rather than closing work: its end is not a
		// step the stall detector should count.
		if (lens) return false;
		const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		if (!plan.ok) return false;
		const task = plan.value.nodes.find((n) => n.task.id === taskId)?.task;
		// An intentional park/handoff is not a failed attempt. Do not increment OR reset the
		// earlier attempts; independent work must still be able to move the run.
		if (
			task &&
			!LoopPlan.isClosed(task) &&
			!LoopPlan.canClaim(task, ctx.now()) &&
			(!claim || !LoopPlan.isActive(task, claim.harness))
		)
			return false;
		const stall = Stall.observe(
			ctx.run.stall ?? Stall.start(""),
			await mark(ctx, plan.value),
		);
		RunState.save(ctx, { ...ctx.run, stall });
		return Stall.stalled(stall, ctx.run.config.stallAfter);
	};

	/**
	 * Settle every session that has ended, then say whether the run has stalled. The whole batch
	 * is settled first: one left out of it would be cancelled by the halt as if its harness had
	 * not stopped, and lose its real outcome and its gates.
	 */
	export const settleAll = async (ctx: Ctx): Promise<boolean> => {
		let stalled = false;
		for (const s of ctx.settled.splice(0))
			if (await settle(ctx, s)) stalled = true;
		return stalled;
	};
}
