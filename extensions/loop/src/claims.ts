// A claim's life in the tracker: open a core session on the subtask, move it to in_progress,
// log the session on it, dispatch; when the session ends with the subtask done, run the gates
// while the claim still holds it; then close the core session, put a subtask the agent left in
// progress and still owned back in the ready pool, record the gates, end the claim, and take a
// progress mark for the stall detector unless the tracker parked or handed off the work. A lens
// is a claim on the parent that leaves its state alone and has no gates; so is the fixer, whose
// gates the runner runs once it has ended. A runner that died mid-claim leaves claims with no
// end; `recover` closes them, finishing a done subtask's gates, and the claim that takes the work
// over continues the interrupted one: its harness session resumed where the harness can, told what
// that attempt left either way.
import type { Harnesses } from "@cabane/acp";
import { err, ok, Planner, type Result, type Task } from "@cabane/core";
import type { Brief } from "./brief";
import { Budget } from "./budget";
import { Checks } from "./checks";
import { Dispatch } from "./dispatch";
import { Fixer } from "./fixer";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import { RunState } from "./state";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

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

	// A lens and the fixer hold the parent without taking it: its state is never theirs to release.
	const onParent = (claim: RunStore.Claim): boolean =>
		claim.lens !== undefined || claim.fixer === true;

	export const mark = async (ctx: Ctx, plan: LoopPlan.Plan): Promise<string> =>
		Stall.mark(
			LoopPlan.closed(plan),
			await ctx.tree(RunStore.sessionDir(ctx.run)),
			Gates.signature(ctx.run.gateRuns.at(-1)),
		);

	// A subtask's pass is recorded before its claim ends (`settle`), so an open claim on a done
	// subtask is one whose runner died between the session closing it and that record: record the
	// pass it already ran, or run the one it never finished.
	const finishPass = async (ctx: Ctx, claim: RunStore.Claim): Promise<void> => {
		const subject = {
			taskId: claim.taskId,
			label: claim.shortId,
			lane: claim.lane,
		};
		const pass =
			ctx.run.gateRuns.findLast(
				(r) => r.taskId === claim.taskId && r.at >= claim.startedAt,
			) ?? (await gatesAfter(ctx, subject));
		if (pass)
			await Checks.record(ctx, pass, { ...subject, assignee: claim.harness });
	};

	/** Close the claims a runner that died left open, finishing the pass a subtask's was owed. */
	export const recover = async (ctx: Ctx): Promise<void> => {
		const open = ctx.run.claims.filter((c) => c.endedAt === undefined);
		for (const claim of open) {
			const detail = "the runner exited while this session was open";
			await closeSession(ctx, claim.sessionId, { outcome: "error", detail });
			if (!onParent(claim)) {
				await finishPass(ctx, claim);
				await release(ctx, claim.taskId, claim.harness);
			}
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
		opened: (acpSessionId) =>
			RunState.patchClaim(ctx, sessionId, { acpSessionId }),
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

	const git = (ctx: Ctx, args: string[]): Promise<string> =>
		(ctx.deps.git ?? Worktree.git)(RunStore.sessionDir(ctx.run), args).then(
			(out) => (out.ok ? out.value.trim() : ""),
		);

	// Its task's work-log entries since it started, but for the loop's own record of its session.
	const loggedSince = async (
		ctx: Ctx,
		attempt: RunStore.Claim,
	): Promise<string[]> => {
		const logs = await Planner.getWorkLogs(ctx.deps.basePath, attempt.taskId);
		if (!logs.ok) return [];
		const own = `session:${attempt.sessionId}`;
		return logs.value
			.filter((log) => log.createdAt >= attempt.startedAt)
			.map((log) => ({
				...log,
				refs: log.refs.filter((ref) => ref.uri !== own),
			}))
			.filter((log) => log.refs.length > 0)
			.map(
				(log) =>
					`${log.refs.map((r) => (r.label ? `${r.uri} (${r.label})` : r.uri)).join(", ")}${log.note ? `: ${log.note}` : ""}`,
			);
	};

	/**
	 * The attempt a new claim takes over when the last one on the same work (`previous`) was
	 * interrupted, as the tracker and the tree show it now; undefined for any other.
	 */
	export const interruption = async (
		ctx: Ctx,
		previous: RunStore.Claim | undefined,
	): Promise<Brief.Interrupted | undefined> => {
		if (previous?.outcome !== "interrupted") return undefined;
		const [logged, commits, status] = await Promise.all([
			loggedSince(ctx, previous),
			git(ctx, ["log", "--oneline", `--since=${previous.startedAt}`]),
			git(ctx, ["status", "--short"]),
		]);
		return {
			lane: previous.lane,
			startedAt: previous.startedAt,
			...(previous.acpSessionId ? { acpSessionId: previous.acpSessionId } : {}),
			logged,
			commits,
			status,
		};
	};

	type Started = {
		task: Task;
		harness: Harnesses.Id;
		lane: string;
		sessionId: string;
		work: Dispatch.Work;
		/** What the trace says about it. */
		summary: string;
		/** The claim before it on the same work, when that one was interrupted. */
		interrupted?: Brief.Interrupted;
	};

	// Record the claim, dispatch its session and hold it live until it has settled.
	const launch = (ctx: Ctx, plan: LoopPlan.Plan, started: Started): void => {
		const { task, harness, lane, sessionId, work, interrupted } = started;
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
					...(work.kind === "fix" ? { fixer: true as const } : {}),
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
			{
				parent: plan.parent,
				task,
				harness,
				sessionId,
				lane,
				work,
				...(interrupted ? { interrupted } : {}),
			},
			{
				basePath: ctx.deps.basePath,
				home: ctx.deps.home,
				kabaneBin: ctx.deps.kabaneBin,
				cwd: RunStore.sessionDir(ctx.run),
				runId: ctx.run.id,
				...(ctx.run.scopeUri ? { scopeUri: ctx.run.scopeUri } : {}),
				...(ctx.deps.mode ? { mode: ctx.deps.mode } : {}),
				overrides: {
					...ctx.deps.overrides?.[harness],
					...(model ? { model } : {}),
				},
			},
			hooks(ctx, sessionId, lane, label(task), harness),
		);
		const settled = handle.done.then(async (outcome) => {
			const gates =
				work.kind === "implement" && outcome.outcome === "done"
					? await gatesAfter(ctx, { taskId: task.id, label: label(task), lane })
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
		const earlier = ctx.run.claims.filter(
			(c) => c.taskId === task.id && !onParent(c),
		);
		const attempts = earlier.length;
		// Named by the subtask alone: every subtask runs on the run's one harness, which the header names.
		const lane = `${label(task)}${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, task, harness, lane, true);
		if (sessionId === undefined) return;
		const retry = Gates.lastFailure(ctx.run.gateRuns, task.id);
		const interrupted = await interruption(ctx, earlier.at(-1));
		launch(ctx, plan, {
			task,
			harness,
			lane,
			sessionId,
			work: { kind: "implement", ...(retry ? { retry } : {}) },
			summary: `${harness} claims ${label(task)}: ${task.title}`,
			...(interrupted ? { interrupted } : {}),
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
		const earlier = ctx.run.claims.filter((c) => c.lens === name);
		const attempts = earlier.length;
		const lane = `${name}-lens${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(new Error(`the ${name} lens's session did not start`));
		const interrupted = await interruption(ctx, earlier.at(-1));
		launch(ctx, plan, {
			...(interrupted ? { interrupted } : {}),
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: {
				kind: "lens",
				name,
				prompt: prompt.value,
				gates: Object.keys(ctx.run.config.gates),
			},
			summary: `${harness} reviews ${label(plan.parent)} through the ${name} lens`,
		});
		return ok(undefined);
	};

	/**
	 * Run the fixer on the parent, on the run's implementer, over `findings` in the order given.
	 * An error when its session cannot start.
	 */
	export const fixer = async (
		ctx: Ctx,
		findings: readonly Task[],
		plan: LoopPlan.Plan,
	): Promise<Result<void>> => {
		const harness = ctx.run.config.implementer;
		const earlier = ctx.run.claims.filter((c) => c.fixer === true);
		const attempts = earlier.length;
		const lane = `${Fixer.LANE}${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(new Error("the fixer's session did not start"));
		const interrupted = await interruption(ctx, earlier.at(-1));
		launch(ctx, plan, {
			...(interrupted ? { interrupted } : {}),
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: {
				kind: "fix",
				findings,
				gates: Object.keys(ctx.run.config.gates),
			},
			summary: `${harness} fixes ${findings.map(label).join(", ")}`,
		});
		return ok(undefined);
	};

	// A session that closed its subtask as done is followed by the gates, while the claim still
	// holds the subtask, so nothing claims it again before its gates have spoken. A worktree run
	// with no gates still takes the pass: it is what commits the subtask's checkpoint, and without
	// one the work stays uncommitted for as long as the agent never commits it itself.
	const gatesAfter = async (
		ctx: Ctx,
		subject: Omit<Checks.Subject, "title"> & { taskId: string },
	) => {
		if (
			!(Gates.configured(ctx.run.config.gates) || ctx.run.worktree) ||
			ctx.stopping.signal.aborted
		)
			return undefined;
		const task = await Planner.getTask(ctx.deps.basePath, subject.taskId);
		if (!task.ok || task.value?.state !== "done") return undefined;
		return Checks.gate(ctx, { ...subject, title: task.value.title });
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
		if (claim && !onParent(claim)) await release(ctx, taskId, claim.harness);
		// Recorded while the claim is still open: a runner that dies before the record leaves an
		// open claim, and `recover` records the pass then.
		if (gates)
			await Checks.record(ctx, gates, {
				taskId,
				label: claim?.shortId ?? taskId,
				assignee: claim?.harness,
				...(claim ? { lane: claim.lane } : {}),
			});
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
