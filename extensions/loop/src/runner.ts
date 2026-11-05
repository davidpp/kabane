// The runner: the one process that drives a run, `kabane loop run <runId>`, detached from
// whoever started it. Every tick it reads the inbox, checks spend, re-reads the plan,
// checks the stop predicate and claims ready subtasks into free slots; between ticks it waits
// for a session to end or the next tick, whichever comes first. Every state change is written
// to run.json before the next step, so a runner that dies can be started again on the same run:
// claims it left open are closed as interrupted and their subtasks released, once a subtask its
// session had closed has had the gate pass (or checkpoint) the dead runner never finished.
// Starting or resuming takes the parent into in_progress, and every end of the run is a comment
// on it (`Parent`). A run that completes lands its branch when its `land` setting says so
// (`Land`). A single issue that gains a work child mid-run is a parent from then on.
import { err, ok, type Result, type Task } from "@cabane/core";
import { Budget } from "./budget";
import { Checks } from "./checks";
import { Claims } from "./claims";
import { Fixer } from "./fixer";
import { Gates } from "./gates";
import { Land } from "./land";
import { Lenses } from "./lenses";
import { Parent } from "./parent";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import { RunState } from "./state";
import { Steering } from "./steering";
import { Stop } from "./stop";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Runner {
	type Deps = RunState.Deps;

	type Ctx = RunState.Ctx;
	type Exit = { status: RunStore.Status; reason: string; detail?: string };

	const TICK_MS = 2_000;
	// How long cancelled sessions get to wind down before their harness is killed.
	const CANCEL_GRACE_MS = 10_000;
	// Consecutive failed plan reads before the run gives up rather than spinning.
	const PLAN_FAILURES = 3;

	const plural = (count: number, noun: string): string =>
		`${count} ${noun}${count === 1 ? "" : "s"}`;

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	const nap = (ctx: Ctx, ms: number): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			ctx.wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});

	const finish = (ctx: Ctx, exit: Exit): RunStore.Run => {
		RunState.save(ctx, {
			...ctx.run,
			status: exit.status,
			exit: {
				reason: exit.reason,
				...(exit.detail ? { detail: exit.detail } : {}),
			},
			endedAt: ctx.now().toISOString(),
		});
		RunState.event(ctx, {
			type: "run_end",
			summary: `${exit.status}: ${exit.reason}${exit.detail ? ` (${exit.detail})` : ""}`,
		});
		return ctx.run;
	};

	/** Cancel what is live, give it time to stop, kill what will not, settle all of it. */
	const halt = async (ctx: Ctx, exit: Exit): Promise<RunStore.Run> => {
		ctx.stopping.abort();
		const pending = [...ctx.live.values()];
		// Cancellation itself can stall on a harness: start every request inside the grace period.
		const cancelling = Promise.allSettled(
			pending.map(async ({ handle, settled }) => {
				await handle.cancel();
				await settled;
			}),
		);
		const all = Promise.allSettled(pending.map((l) => l.settled));
		await Promise.race([cancelling, sleep(CANCEL_GRACE_MS)]);
		for (const { handle } of pending) handle.close();
		await Promise.race([all, sleep(CANCEL_GRACE_MS)]);
		await Claims.settleAll(ctx);
		for (const [sessionId, { taskId }] of ctx.live)
			await Claims.settle(ctx, {
				taskId,
				sessionId,
				outcome: { outcome: "cancelled", detail: "the harness did not stop" },
			});
		await Parent.report(ctx, exit);
		return finish(ctx, exit);
	};

	// Text for a session goes to it while it is live, and is dropped, saying so, once it is not.
	const deliver = (
		ctx: Ctx,
		entry: Extract<RunStore.InboxEntry, { kind: "inject" }>,
	): void => {
		const live = ctx.live.get(entry.session);
		if (live) void live.handle.inject(entry.text);
		else
			RunState.event(ctx, {
				type: "warning",
				lane: entry.lane,
				session: entry.session,
				summary: `inject for ${entry.lane} dropped: its session has ended`,
			});
	};

	// `answered` notes are the permission relay's to read, from the start of the inbox.
	const readInbox = (ctx: Ctx): void => {
		const inbox = RunStore.readInbox(
			ctx.deps.home,
			ctx.run.id,
			ctx.run.inboxRead,
		);
		if (!inbox.ok || inbox.value.next === ctx.run.inboxRead) return;
		for (const line of inbox.value.invalid)
			RunState.event(ctx, {
				type: "warning",
				summary: `inbox line ignored: ${line}`,
			});
		let steering = ctx.run.steering;
		for (const entry of inbox.value.entries) {
			switch (entry.kind) {
				case "stop":
					ctx.stopRequested = true;
					break;
				case "inject":
					deliver(ctx, entry);
					break;
				case "answered":
					break;
				case "rolled_back":
					RunState.event(ctx, Worktree.rolledBack(entry.sha, entry.by));
					break;
				default: {
					const applied = Steering.apply(steering, entry);
					steering = applied.state;
					RunState.event(ctx, {
						type: applied.type,
						summary: applied.summary,
						...(entry.kind === "skip" || entry.kind === "next"
							? { task: entry.task }
							: {}),
					});
				}
			}
		}
		RunState.save(ctx, { ...ctx.run, steering, inboxRead: inbox.value.next });
	};

	// Say once why nothing moves, rather than on every tick.
	const reportWaiting = (
		ctx: Ctx,
		health: LoopPlan.Health,
		last: { said: string },
	): void => {
		const said = ctx.run.steering.paused
			? `paused with ${plural(ctx.live.size, "session")} running`
			: health.kind === "waiting"
				? `waiting on ${health.on.join(", ") || "nothing claimable"}`
				: "";
		if (said !== "" && said !== last.said)
			RunState.event(ctx, { type: "waiting", summary: said });
		last.said = said;
	};

	type TickState = {
		planFailures: number;
		health: { said: string };
		/** Whether this runner has seen its single issue become a parent, and taken it as one. */
		reshaped?: "seen" | "taken";
	};

	// The states the end of its own session leaves a single issue in: released, or closed.
	const LEFT_BY_CLAIM: readonly Task["state"][] = ["next", "done"];

	/**
	 * A single issue a human gave a work child during the run is a parent from then on, and the
	 * run works its subtasks as it would have from the start: the tracker is the plan. Any session
	 * already on the issue itself (its implementer, a lens, the fixer) is left to finish, since
	 * cancelling it would throw away its work, and the subtasks wait for it, so two sessions never
	 * work in one tree on the same change. Once every one has ended the issue is taken as a parent
	 * is. True while a session on the issue holds the subtasks back.
	 */
	const reshape = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
		state: TickState,
	): Promise<boolean> => {
		if (LoopPlan.single(plan)) return false;
		const own = RunStore.onTarget(ctx.run);
		if (own.length === 0) return false;
		const holding = ctx.run.claims.some(
			(c) => c.taskId === ctx.run.parentId && c.endedAt === undefined,
		);
		const short = ctx.run.parentShortId;
		if (state.reshaped === undefined) {
			const added = plan.nodes
				.filter(LoopPlan.isWork)
				.map((n) => n.task.shortId ?? n.task.id);
			RunState.event(ctx, {
				type: "reshaped",
				summary: `${short} has subtasks now (${added.join(", ")}): the run works them as its plan${holding ? `, once every session on ${short} itself has ended` : ""}`,
			});
			state.reshaped = "seen";
		}
		if (!holding && state.reshaped === "seen") {
			await Parent.take(
				ctx,
				"subtasks added: loop run works them",
				LEFT_BY_CLAIM,
			);
			state.reshaped = "taken";
		}
		return holding;
	};

	/** One pass: the exit when the run is over, else undefined after claiming. */
	const tick = async (
		ctx: Ctx,
		state: TickState,
	): Promise<Exit | undefined> => {
		readInbox(ctx);
		if (ctx.stopRequested)
			return { status: "stopped", reason: "stop-requested" };
		const verdict = Budget.check(ctx.run.config.budget, ctx.run.usage);
		if (!verdict.ok)
			return {
				status: "stopped",
				reason: `budget:${verdict.reason}`,
				detail: verdict.detail,
			};
		const loaded = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		if (!loaded.ok) {
			state.planFailures += 1;
			RunState.event(ctx, {
				type: "warning",
				summary: `plan not read: ${loaded.error.message}`,
			});
			return state.planFailures >= PLAN_FAILURES
				? {
						status: "failed",
						reason: "plan-unreadable",
						detail: loaded.error.message,
					}
				: undefined;
		}
		state.planFailures = 0;
		const plan = loaded.value;
		const holding = await reshape(ctx, plan, state);
		if (ctx.live.size === 0 && Stop.workDone(plan))
			return finalChecks(ctx, plan);
		const skipped = new Set(ctx.run.steering.skipped);
		const ready = holding
			? []
			: LoopPlan.frontier(plan, RunState.liveTasks(ctx), ctx.now(), skipped);
		const slots = Budget.slots(ctx.run.config.budget, ctx.live.size);
		for (const node of Steering.pick(ctx.run.steering, ready, slots)) {
			await Claims.claim(ctx, node, plan);
			RunState.save(ctx, {
				...ctx.run,
				steering: Steering.claimed(ctx.run.steering, node.task.id),
			});
		}
		const health = LoopPlan.health(
			plan,
			RunState.liveTasks(ctx),
			ctx.now(),
			skipped,
		);
		if (health.kind === "deadlocked")
			return {
				status: "stopped",
				reason: "deadlocked",
				detail: `cycle: ${health.cycle.join(" → ")}`,
			};
		reportWaiting(ctx, health, state.health);
		return undefined;
	};

	/**
	 * Run `body` while still hearing a stop: the inbox is read every tick meanwhile, and a stop
	 * kills what `body` is running through `ctx.stopping`.
	 */
	const hearingStop = async <T>(
		ctx: Ctx,
		body: () => Promise<T>,
	): Promise<T> => {
		const timer = setInterval(() => {
			readInbox(ctx);
			if (ctx.stopRequested) ctx.stopping.abort();
		}, ctx.deps.tickMs ?? TICK_MS);
		try {
			return await body();
		} finally {
			clearInterval(timer);
		}
	};

	/**
	 * Whether the result as it is has been checked: the gates are green on it and, in a run with a
	 * worktree, a pass has checkpointed it (a pass is how a worktree run commits, gates or none).
	 */
	const checked = async (ctx: Ctx): Promise<boolean> => {
		const tree = await ctx.tree(RunStore.sessionDir(ctx.run));
		return (
			Gates.green(ctx.run.config.gates, ctx.run.gateRuns, tree) &&
			(ctx.run.worktree === undefined || ctx.run.gateRuns.at(-1)?.tree === tree)
		);
	};

	/**
	 * The work is done and nothing is running. The phases that follow, each once: the gates on the
	 * result, the lenses on work that passes them, the fixer on what the lenses found, and the gates
	 * once more on what the fixer changed. The run completes when all of it has happened. The fixer
	 * does not wait for the gates: the lenses saw them green, and a fixer resumed after its runner
	 * died picks up a half-fixed tree. Undefined goes on ticking.
	 */
	const finalChecks = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
	): Promise<Exit | undefined> => {
		const gatesGreen = await checked(ctx);
		const reviewed = Lenses.status(ctx.run.config.lenses, ctx.run.claims);
		const lensesDone = Lenses.finished(reviewed);
		const fixer = Fixer.status(ctx.run.claims);
		const findings = LoopPlan.fixable(
			plan,
			ctx.now(),
			new Set(ctx.run.steering.skipped),
		);
		const fixerDone =
			fixer.kind === "ended" ||
			(fixer.kind === "unstarted" && findings.length === 0);
		if (Stop.evaluate(plan, { gatesGreen, lensesDone, fixerDone }).done) {
			// A landing that fails still completes the run: the work is done and checked.
			if (ctx.run.config.land === "pr") {
				await hearingStop(ctx, () => Land.land(ctx, plan));
				if (ctx.stopRequested)
					return { status: "stopped", reason: "stop-requested" };
			}
			const { open } = LoopPlan.findings(plan);
			return {
				status: "completed",
				reason: "plan-done",
				...(open > 0
					? { detail: `${plural(open, "finding")} left open for a human` }
					: {}),
			};
		}
		if (!lensesDone) {
			if (!gatesGreen) return finalGates(ctx, plan);
			const failed = reviewed.failed[0];
			if (failed)
				return {
					status: "stopped",
					reason: "lens-failed",
					detail: `${failed.name}: ${failed.detail}`,
				};
			return startLenses(ctx, plan, reviewed.pending);
		}
		if (fixer.kind === "failed")
			return {
				status: "stopped",
				reason: "fixer-failed",
				detail: fixer.detail,
			};
		if (!fixerDone) return startFixer(ctx, plan, findings);
		return finalGates(ctx, plan);
	};

	// Lenses take free slots like any claim, and none while the run is paused. Their findings are
	// children of the parent, for the fixer once every lens has reviewed.
	const startLenses = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
		pending: readonly string[],
	): Promise<Exit | undefined> => {
		if (ctx.run.steering.paused) return undefined;
		const slots = Budget.slots(ctx.run.config.budget, ctx.live.size);
		for (const name of pending.slice(0, slots)) {
			const started = await Claims.lens(ctx, name, plan);
			if (!started.ok)
				return {
					status: "stopped",
					reason: "lens-failed",
					detail: `${name}: ${started.error.message}`,
				};
		}
		return undefined;
	};

	// One session takes every finding the run may claim, most severe first. Not while paused.
	const startFixer = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
		findings: readonly LoopPlan.Node[],
	): Promise<Exit | undefined> => {
		if (ctx.run.steering.paused) return undefined;
		const started = await Claims.fixer(
			ctx,
			findings.map((n) => n.task),
			plan,
		);
		return started.ok
			? undefined
			: {
					status: "stopped",
					reason: "fixer-failed",
					detail: started.error.message,
				};
	};

	// Gates not green on the tree as it is (none run since the last change) run once more; a red
	// pass with no subtask to reopen stops the run for a human.
	const finalGates = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
	): Promise<Exit | undefined> => {
		const label = ctx.run.parentShortId;
		const pass = await hearingStop(ctx, () =>
			Checks.gate(ctx, { label, title: plan.parent.title }),
		);
		await Checks.record(ctx, pass, { taskId: ctx.run.parentId, label });
		if (ctx.stopRequested)
			return { status: "stopped", reason: "stop-requested" };
		const failed = pass.results.find((r) => !r.ok);
		return failed
			? {
					status: "stopped",
					reason: "gates-red",
					detail: Gates.describe(failed),
				}
			: undefined;
	};

	/** Undefined once the run is ready to go on; the exit when it must wait for a human first. */
	const boot = async (ctx: Ctx): Promise<Exit | undefined> => {
		const resumed = ctx.run.startedAt !== undefined;
		const now = ctx.now().toISOString();
		const pidStart = RunStore.processStart(ctx.deps.pid);
		RunState.save(ctx, {
			...ctx.run,
			status: "running",
			exit: undefined,
			pid: ctx.deps.pid,
			pidStart: pidStart.ok ? pidStart.value : undefined,
			startedAt: ctx.run.startedAt ?? now,
		});
		RunState.event(ctx, {
			type: resumed ? "run_resume" : "run_start",
			summary: `${resumed ? "resumed" : "started"} on ${ctx.run.parentShortId} in ${RunStore.sessionDir(ctx.run)} (pid ${ctx.deps.pid})`,
		});
		// A landing the dead runner left half done is undone first: the gates recovery may run, and
		// the sessions after it, would otherwise work on a half-replayed tree. One that cannot be
		// undone stops the run here, before anything else touches the worktree.
		const undone = await Land.recover(ctx);
		if (!undone.ok)
			return {
				status: "failed",
				reason: RunStore.LANDING_UNRECOVERED,
				detail: `${undone.error.message}, then \`kabane loop resume ${ctx.run.id}\``,
			};
		// A run that has worked its target itself leaves taking it to `reshape`, after recovery: the
		// issue's state is its claim's until then (a pass owed on it, a release), and one a human
		// set meanwhile is theirs.
		if (RunStore.onTarget(ctx.run).length === 0)
			await Parent.take(ctx, `loop run ${resumed ? "resumed" : "started"}`);
		// Recovery may run a subtask's gates, which a stop must still be able to kill.
		await hearingStop(ctx, () => Claims.recover(ctx));
		if (ctx.run.stall === undefined) {
			const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
			RunState.save(ctx, {
				...ctx.run,
				stall: Stall.start(plan.ok ? await Claims.mark(ctx, plan.value) : ""),
			});
		}
		return undefined;
	};

	const loop = async (ctx: Ctx): Promise<RunStore.Run> => {
		const state: TickState = { planFailures: 0, health: { said: "" } };
		for (;;) {
			const exit = await tick(ctx, state);
			if (exit) return halt(ctx, exit);
			if (ctx.settled.length === 0) await nap(ctx, ctx.deps.tickMs ?? TICK_MS);
			if (await Claims.settleAll(ctx))
				return halt(ctx, {
					status: "stopped",
					reason: "stalled",
					detail: `no progress across ${ctx.run.config.stallAfter} attempts`,
				});
		}
	};

	// A run that resumes must still be its parent's only live run: another may have been started
	// on it while this one lay dead, and two would claim the same subtasks.
	const rival = (home: string, run: RunStore.Run): Result<void> => {
		const runs = RunStore.list(home);
		if (!runs.ok) return runs;
		const other = runs.value.find(
			(r) =>
				r.id !== run.id &&
				r.parentId === run.parentId &&
				RunStore.isLive(r.status),
		);
		return other
			? err(
					new Error(
						`Run ${run.id} cannot resume: ${run.parentShortId} already has a live loop run, ${other.id}; stop it first`,
					),
				)
			: ok(undefined);
	};

	/**
	 * Drive run `runId` in this process until it is over. A pending run starts; a run whose
	 * runner died resumes, unless another live run has its parent; anything else is refused.
	 */
	export const run = async (
		runId: string,
		deps: Deps,
	): Promise<Result<RunStore.Run>> => {
		const read = RunStore.read(deps.home, runId);
		if (!read.ok) return read;
		const first = read.value;
		const resumable = first.status === "pending" || RunStore.restartable(first);
		if (!resumable)
			return err(
				new Error(
					`Run ${runId} is already ${first.status}${first.status === "running" ? ` (pid ${first.pid})` : ""}`,
				),
			);
		if (first.status !== "pending") {
			const alone = rival(deps.home, first);
			if (!alone.ok) return alone;
		}
		const log = RunStore.eventLog(deps.home, runId, deps.now);
		if (!log.ok) return log;
		const ctx = RunState.make(deps, first, log.value);
		deps.signal?.addEventListener("abort", () => {
			ctx.stopRequested = true;
			ctx.stopping.abort();
			ctx.wake();
		});
		const waits = await boot(ctx);
		return ok(waits ? await halt(ctx, waits) : await loop(ctx));
	};
}
