// The runner: the one process that drives a run, `kabane loop run <runId>`, detached from
// whoever started it. Every tick it reads the inbox, checks the budget, re-reads the plan,
// checks the stop predicate and claims ready subtasks into free slots; between ticks it waits
// for a session to end or the next tick, whichever comes first. Every state change is written
// to run.json before the next step, so a runner that dies can be started again on the same run:
// claims it left open are closed as interrupted and their subtasks released.
import { err, ok, type Result } from "@cabane/core";
import { Budget } from "./budget";
import { Claims } from "./claims";
import { LoopPlan } from "./plan";
import { Stall } from "./stall";
import { RunState } from "./state";
import { Steering } from "./steering";
import { Stop } from "./stop";
import { RunStore } from "./store";

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

	const git = (cwd: string, args: string[]): string => {
		const out = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stderr: "ignore",
		});
		return out.success ? out.stdout.toString() : "";
	};

	/** HEAD, the status and the diff, hashed: changes whenever an agent changes a file. */
	const gitTree = (cwd: string): string =>
		Bun.hash(
			[
				git(cwd, ["rev-parse", "HEAD"]),
				git(cwd, ["status", "--porcelain"]),
				git(cwd, ["diff"]),
			].join("\0"),
		).toString(36);

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
		const pending = [...ctx.live.values()];
		for (const { handle } of pending) await handle.cancel();
		const all = Promise.allSettled(pending.map((l) => l.handle.done));
		await Promise.race([all, sleep(CANCEL_GRACE_MS)]);
		for (const { handle } of pending) handle.close();
		await Promise.race([all, sleep(CANCEL_GRACE_MS)]);
		for (const s of ctx.settled.splice(0)) await Claims.settle(ctx, s);
		for (const [taskId, { sessionId }] of ctx.live)
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
		const live = [...ctx.live.values()].find(
			(l) => l.sessionId === entry.session,
		);
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
		const verdict = Budget.check(ctx.run.config.budget, ctx.run.usage, {
			startedAt: ctx.run.startedAt ?? ctx.run.createdAt,
			now: ctx.now(),
		});
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
		if (Stop.evaluate(plan).done && ctx.live.size === 0)
			return { status: "completed", reason: "plan-done" };
		const skipped = new Set(ctx.run.steering.skipped);
		const ready = LoopPlan.frontier(
			plan,
			new Set(ctx.live.keys()),
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
			new Set(ctx.live.keys()),
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

	const boot = async (ctx: Ctx): Promise<void> => {
		const resumed = ctx.run.startedAt !== undefined;
		RunState.save(ctx, {
			...ctx.run,
			status: "running",
			exit: undefined,
			pid: ctx.deps.pid,
			startedAt: ctx.run.startedAt ?? ctx.now().toISOString(),
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
				stall: Stall.start(plan.ok ? Claims.mark(ctx, plan.value) : ""),
			});
		}
	};

	const loop = async (ctx: Ctx): Promise<RunStore.Run> => {
		const state: TickState = { planFailures: 0, health: { said: "" } };
		for (;;) {
			const exit = await tick(ctx, state);
			if (exit) return halt(ctx, exit);
			if (ctx.settled.length === 0) await nap(ctx, ctx.deps.tickMs ?? TICK_MS);
			for (const s of ctx.settled.splice(0)) {
				if (await Claims.settle(ctx, s))
					return halt(ctx, {
						status: "stopped",
						reason: "stalled",
						detail: `no progress across ${ctx.run.config.stallAfter} session ends`,
					});
			}
		}
	};

	/**
	 * Drive run `runId` in this process until it is over. A pending run starts; a run whose
	 * runner died resumes; anything else is refused.
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
		};
		deps.signal?.addEventListener("abort", () => {
			ctx.stopRequested = true;
			ctx.wake();
		});
		await boot(ctx);
		return ok(await loop(ctx));
	};
}
