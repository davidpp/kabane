// The runner: the one process that drives a run, `kabane loop run <runId>`, detached from
// whoever started it. Every tick it reads the inbox, checks the budget, re-reads the plan,
// checks the stop predicate and claims ready subtasks into free slots; between ticks it waits
// for a session to end or the next tick, whichever comes first. Every state change is written
// to run.json before the next step, so a runner that dies can be started again on the same run:
// claims it left open are closed as interrupted and their subtasks released.
import { err, ok, type Result } from "@cabane/core";
import { Budget } from "./budget";
import { Checks } from "./checks";
import { Claims } from "./claims";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
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
	// How often the run's clock is saved: a runner that dies loses at most this much of it.
	const CLOCK_SAVE_MS = 30_000;

	const plural = (count: number, noun: string): string =>
		`${count} ${noun}${count === 1 ? "" : "s"}`;

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	const git = async (cwd: string, args: string[]): Promise<string> => {
		const out = await Worktree.git(cwd, args);
		return out.ok ? out.value : "";
	};

	/** HEAD, the status and the diff, hashed: changes whenever an agent changes a file. */
	const gitTree = async (cwd: string): Promise<string> =>
		Bun.hash(
			(
				await Promise.all([
					git(cwd, ["rev-parse", "HEAD"]),
					git(cwd, ["status", "--porcelain"]),
					git(cwd, ["diff"]),
				])
			).join("\0"),
		).toString(36);

	const nap = (ctx: Ctx, ms: number): Promise<void> =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, ms);
			ctx.wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});

	// Wall time spent so far, with the clock saved once it is older than CLOCK_SAVE_MS.
	const clock = (ctx: Ctx, force = false): number => {
		const now = ctx.now();
		const spentMs = RunStore.wallMs(ctx.run, now);
		const at = ctx.run.clock ? Date.parse(ctx.run.clock.at) : 0;
		if (force || now.getTime() - at >= CLOCK_SAVE_MS)
			RunState.save(ctx, {
				...ctx.run,
				clock: { spentMs, at: now.toISOString() },
			});
		return spentMs;
	};

	const finish = (ctx: Ctx, exit: Exit): RunStore.Run => {
		clock(ctx, true);
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
		for (const { handle } of pending) await handle.cancel();
		const all = Promise.allSettled(pending.map((l) => l.settled));
		await Promise.race([all, sleep(CANCEL_GRACE_MS)]);
		for (const { handle } of pending) handle.close();
		await Promise.race([all, sleep(CANCEL_GRACE_MS)]);
		await Claims.settleAll(ctx);
		for (const [sessionId, { taskId }] of ctx.live)
			await Claims.settle(ctx, {
				taskId,
				sessionId,
				outcome: { outcome: "cancelled", detail: "the harness did not stop" },
			});
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

	type TickState = { planFailures: number; health: { said: string } };

	/** One pass: the exit when the run is over, else undefined after claiming. */
	const tick = async (
		ctx: Ctx,
		state: TickState,
	): Promise<Exit | undefined> => {
		readInbox(ctx);
		if (ctx.stopRequested)
			return { status: "stopped", reason: "stop-requested" };
		const verdict = Budget.check(
			ctx.run.config.budget,
			ctx.run.usage,
			clock(ctx),
		);
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
		if (ctx.live.size === 0 && Stop.workDone(plan))
			return finalChecks(ctx, plan);
		const skipped = new Set(ctx.run.steering.skipped);
		const ready = LoopPlan.frontier(
			plan,
			RunState.liveTasks(ctx),
			ctx.now(),
			skipped,
		);
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
	 * The work is done and nothing is running: the run completes once its gates are green on the
	 * tree as it is and every lens has reviewed it. Gates come first, so a lens reviews work that
	 * passes them. Undefined goes on ticking.
	 */
	const finalChecks = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
	): Promise<Exit | undefined> => {
		const { gates, lenses } = ctx.run.config;
		const gatesGreen = Gates.green(
			gates,
			ctx.run.gateRuns,
			await ctx.tree(RunStore.sessionDir(ctx.run)),
		);
		const reviewed = Lenses.status(lenses, ctx.run.claims);
		const checks = { gatesGreen, lensesDone: Lenses.finished(reviewed) };
		if (Stop.evaluate(plan, checks).done)
			return { status: "completed", reason: "plan-done" };
		if (!gatesGreen) return finalGates(ctx, plan);
		const failed = reviewed.failed[0];
		if (failed)
			return {
				status: "stopped",
				reason: "lens-failed",
				detail: `${failed.name}: ${failed.detail}`,
			};
		return startLenses(ctx, plan, reviewed.pending);
	};

	// Lenses take free slots like any claim, and none while the run is paused. Their findings are
	// children of the parent, so an open `p1` is claimed as work on the next tick.
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

	const boot = async (ctx: Ctx): Promise<void> => {
		const resumed = ctx.run.startedAt !== undefined;
		const now = ctx.now().toISOString();
		RunState.save(ctx, {
			...ctx.run,
			status: "running",
			exit: undefined,
			pid: ctx.deps.pid,
			startedAt: ctx.run.startedAt ?? now,
			// The clock goes on from what the last runner saved, not from when it died.
			clock: { spentMs: ctx.run.clock?.spentMs ?? 0, at: now },
		});
		RunState.event(ctx, {
			type: resumed ? "run_resume" : "run_start",
			summary: `${resumed ? "resumed" : "started"} on ${ctx.run.parentShortId} in ${RunStore.sessionDir(ctx.run)} (pid ${ctx.deps.pid})`,
		});
		await Claims.recover(ctx);
		if (ctx.run.stall === undefined) {
			const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
			RunState.save(ctx, {
				...ctx.run,
				stall: Stall.start(plan.ok ? await Claims.mark(ctx, plan.value) : ""),
			});
		}
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
					detail: `no progress across ${ctx.run.config.stallAfter} session ends`,
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
		const resumable =
			first.status === "pending" || first.exit?.reason === "runner-died";
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
		const ctx: Ctx = {
			deps,
			now: deps.now ?? (() => new Date()),
			tree: deps.tree ?? gitTree,
			log: log.value,
			run: first,
			live: new Map(),
			settled: [],
			wake: () => {},
			stopRequested: false,
			stopping: new AbortController(),
			gating: Promise.resolve(),
		};
		deps.signal?.addEventListener("abort", () => {
			ctx.stopRequested = true;
			ctx.stopping.abort();
			ctx.wake();
		});
		await boot(ctx);
		return ok(await loop(ctx));
	};
}
