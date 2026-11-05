// The loop's entry points, as plain functions over explicit dependencies. The extension wires
// them to `kabane loop start|run|status|stop|pause|resume|skip|next|rollback|answer`; nothing here parses argv or reads the
// environment for its own settings. A run whose runner died is restarted (`restart`) where it
// stopped, with its claims and its worktree.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Harnesses } from "@cabane/acp";
import {
	err,
	ok,
	type AgentActivity,
	isAnswerTo,
	type ParsedQuestion,
	Planner,
	parseQuestionBody,
	type Result,
	ScopeUri,
	type Task,
	tryCatch,
	trySync,
} from "@cabane/core";
import { detectScope } from "@cabane/core/scope";
import type { Settings } from "@cabane/extension";
import { LoopConfig } from "./config";
import { Elicitation } from "./elicitation";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import { Questions } from "./questions";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { Stop } from "./stop";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Loop {
	export type Deps = {
		/** KABANE_HOME. */
		home: string;
		/** The core base path (the database's directory). */
		basePath: string;
		/** The `kabane` executable: the runner's binary, and each session's MCP server. */
		kabaneBin: string;
	};

	export type StartDeps = Deps & {
		/** Where the loop was started from (the CLI's cwd, the board's). */
		cwd: string;
		/** The command that drives a run. Defaults to `kabane loop run <runId>` on `kabaneBin`. */
		runner?: (runId: string) => string[];
		now?: () => Date;
		/** How long `start` waits for the runner to report that it is running. */
		bootMs?: number;
		/** How the run's worktree is made. Defaults to the user's own git. */
		git?: Worktree.Git;
		/** Where a run's settings resolve through their layers: the extension context's port. */
		settings: Settings.Port;
	};

	export type StartInput = {
		/** The parent issue, or a single issue with no subtasks: id or short id. */
		parent: string;
		/**
		 * The project checkout to work on, relative to `cwd`. Absent, it is `cwd`, which must
		 * then be the parent issue's scope. The settings resolve for it: its `.kabane/loop.json`,
		 * and the user's settings for its scope.
		 */
		dir?: string;
		config?: LoopConfig.Overrides;
	};

	const RUNNER_ACTOR = "cabane://actor/agent/loop";
	const BOOT_MS = 15_000;
	const STOP_WAIT_MS = 30_000;
	const POLL_MS = 100;
	const LOG_TAIL = 2_000;

	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));

	const defaultRunner =
		(kabaneBin: string) =>
		(runId: string): string[] => [
			kabaneBin,
			"loop",
			"run",
			runId,
			"--as",
			RUNNER_ACTOR,
		];

	const logTail = (home: string, runId: string): string => {
		const file = RunStore.paths(home, runId).log;
		if (!existsSync(file)) return "";
		const text = trySync(() => readFileSync(file, "utf8"));
		return text.ok ? text.value.slice(-LOG_TAIL).trim() : "";
	};

	/** Whether the run's runner died under it: what `restart` takes up again. */
	export const died = (run: RunStore.Run): boolean =>
		run.exit?.reason === "runner-died";

	/** What a human runs to bring a run whose runner died back. */
	export const restartCommand = (runId: string): string =>
		`kabane loop resume ${runId}`;

	const diedError = (run: RunStore.Run): Error =>
		new Error(
			`Run ${run.id}'s runner died: \`${restartCommand(run.id)}\` restarts it`,
		);

	const markFailed = (
		home: string,
		run: RunStore.Run,
		reason: string,
		detail: string,
	) =>
		RunStore.write(home, {
			...run,
			status: "failed",
			exit: { reason, detail },
			endedAt: new Date().toISOString(),
		});

	// What spawning a runner and waiting for it to boot take.
	type SpawnDeps = Pick<StartDeps, "home" | "kabaneBin" | "runner" | "bootMs">;

	/** Spawn the runner detached from this process, its output going to the run's log. */
	const spawnRunner = (
		deps: SpawnDeps,
		run: RunStore.Run,
	): Result<{ exited: () => number | null | undefined }> => {
		const runId = run.id;
		const argv = (deps.runner ?? defaultRunner(deps.kabaneBin))(runId);
		const [command, ...args] = argv;
		if (command === undefined)
			return err(new Error("The runner command is empty"));
		const fd = trySync(() =>
			openSync(RunStore.paths(deps.home, runId).log, "a"),
		);
		if (!fd.ok) return fd;
		let exit: number | null | undefined;
		const child = trySync(() =>
			spawn(command, args, {
				cwd: run.projectDir,
				detached: true,
				stdio: ["ignore", fd.value, fd.value],
				env: { ...process.env, KABANE_HOME: deps.home },
			}),
		);
		closeSync(fd.value);
		if (!child.ok) return child;
		child.value.on("error", () => {
			exit = null;
		});
		child.value.on("exit", (code) => {
			exit = code;
		});
		child.value.unref();
		return ok({ exited: () => exit });
	};

	// Until the runner reports, a pending run is pending and a restarted one still reads as its
	// dead runner's. A restart whose runner exits before it reports is left as it was, dead and
	// still restartable, rather than marked failed for good.
	const awaitBoot = async (
		deps: SpawnDeps,
		run: RunStore.Run,
		exited: () => number | null | undefined,
	): Promise<Result<RunStore.Run>> => {
		const booted = (now: RunStore.Run): boolean =>
			now.status !== "pending" && !(died(now) && now.pid === run.pid);
		const deadline = Date.now() + (deps.bootMs ?? BOOT_MS);
		while (Date.now() < deadline) {
			const now = RunStore.read(deps.home, run.id);
			if (now.ok && booted(now.value)) return now;
			if (exited() !== undefined) {
				const detail = `the runner exited (${exited()}) before it started: ${logTail(deps.home, run.id)}`;
				if (run.status === "pending")
					markFailed(deps.home, run, "runner-exited", detail);
				return err(new Error(detail));
			}
			await sleep(POLL_MS);
		}
		const detail = `the runner did not report within ${deps.bootMs ?? BOOT_MS} ms; see ${RunStore.paths(deps.home, run.id).log}`;
		return err(new Error(detail));
	};

	const liveRunOn = (
		runs: readonly RunStore.Run[],
		parentId: string,
		except?: string,
	): RunStore.Run | undefined =>
		runs.find(
			(r) =>
				r.id !== except && r.parentId === parentId && RunStore.isLive(r.status),
		);

	// The parent must have something for a run to do (open work, checks to run on work that is
	// done, or open findings for the fixer), no live run already, and a last run whose runner did
	// not die: that run still holds the subtasks it claimed, which a new run would wait on
	// forever, and its worktree. A single issue that is open must be one the run can claim: with
	// no sibling to work meanwhile, a run on one someone holds would only wait.
	const checkParent = async (
		deps: Pick<StartDeps, "home">,
		plan: LoopPlan.Plan,
		config: LoopConfig.Config,
		projectDir: string,
	): Promise<Result<void>> => {
		const { parent } = plan;
		const short = parent.shortId ?? parent.id;
		const now = new Date();
		if (!plan.nodes.some(LoopPlan.isWork))
			return err(
				new Error(
					`${short} is a ${parent.kind} with no subtasks, so a loop has nothing to run: make it an issue, or give it issue subtasks`,
				),
			);
		const single = LoopPlan.single(plan);
		if (single && !LoopPlan.isClosed(parent) && !LoopPlan.canClaim(parent, now))
			return err(
				new Error(
					`${short} is ${parent.state === "next" || parent.state === "inbox" ? `deferred until ${parent.deferUntil}` : parent.state}, so a loop run could not claim it: move it to next to run it`,
				),
			);
		if (
			Stop.workDone(plan) &&
			!Gates.configured(config.gates) &&
			config.lenses.length === 0 &&
			LoopPlan.fixable(plan, now).length === 0
		)
			return err(
				new Error(
					`${single ? `${short} is already ${parent.state}` : `Every subtask of ${short} is already closed`}, no finding under it is open, and no gates or lenses are configured to check it`,
				),
			);
		// A lens with no prompt would fail the run at its end; say so before it starts.
		for (const name of config.lenses) {
			const prompt = Lenses.prompt(projectDir, name);
			if (!prompt.ok) return prompt;
		}
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const active = liveRunOn(runs.value, plan.parent.id);
		if (active)
			return err(
				new Error(`${short} already has a live loop run: ${active.id}`),
			);
		// Newest first: the parent's last run.
		const last = runs.value.find((r) => r.parentId === plan.parent.id);
		return last && died(last)
			? err(
					new Error(
						`${short}'s last loop run ${last.id} lost its runner: \`${restartCommand(last.id)}\` restarts it with its claims and worktree, and \`kabane loop stop ${last.id}\` after that abandons it`,
					),
				)
			: ok(undefined);
	};

	/**
	 * The checkout the run works on. A scope URI does not say where a project is checked out, so
	 * the directory the loop was started from must be the parent's scope; an explicit `dir` is the
	 * caller saying so and is taken as given.
	 */
	const projectDirFor = async (
		deps: Pick<StartDeps, "home" | "cwd">,
		parent: Task,
		dir: string | undefined,
	): Promise<Result<string>> => {
		if (dir !== undefined) return ok(resolve(deps.cwd, dir));
		const projectDir = resolve(deps.cwd);
		if (!parent.scopeUri) return ok(projectDir);
		const detected = await tryCatch(() =>
			detectScope(projectDir, { home: deps.home, detectExtensions: false }),
		);
		if (!detected.ok) return detected;
		// Same scope id, whatever extensions either side carries (`?package=`, `?branch=`),
		// the way a scoped query matches the family.
		const wanted = ScopeUri.getScopeId(parent.scopeUri);
		const found = detected.value?.scopeUri;
		if (wanted.ok && detected.value?.scopeId === wanted.value)
			return ok(projectDir);
		return err(
			new Error(
				`${projectDir} is ${found ?? "not a project"}, not ${parent.shortId ?? parent.id}'s scope ${parent.scopeUri}: start the loop from that checkout, or pass --dir`,
			),
		);
	};

	/** What a run would start with: the plan as it stands, the checkout, the resolved config. */
	export type Prepared = {
		plan: LoopPlan.Plan;
		projectDir: string;
		config: LoopConfig.Config;
	};

	/**
	 * Everything `start` checks and resolves before it writes a run, without writing one: what the
	 * board's trigger shows before the human starts it. Refuses a directory that is not the
	 * parent's scope (unless `input.dir` names it), a parent with nothing for a run to do, a lens
	 * with no prompt, and a parent that already has a live run.
	 */
	export const prepare = async (
		deps: Pick<StartDeps, "home" | "basePath" | "cwd" | "settings">,
		input: StartInput,
	): Promise<Result<Prepared>> => {
		const parentId = await Planner.resolveTaskId(deps.basePath, input.parent);
		if (!parentId.ok) return parentId;
		const plan = await LoopPlan.load(deps.basePath, parentId.value);
		if (!plan.ok) return plan;
		const projectDir = await projectDirFor(deps, plan.value.parent, input.dir);
		if (!projectDir.ok) return projectDir;
		const config = await deps.settings(
			LoopConfig.NAMESPACE,
			LoopConfig.SettingsSchema,
			{
				projectDir: projectDir.value,
				...(input.config ? { overrides: input.config } : {}),
			},
		);
		if (!config.ok) return config;
		// Whether there is anything to do depends on the config: checks can run on done work.
		const checked = await checkParent(
			deps,
			plan.value,
			config.value,
			projectDir.value,
		);
		if (!checked.ok) return checked;
		return ok({
			plan: plan.value,
			projectDir: projectDir.value,
			config: config.value,
		});
	};

	/**
	 * Write a run for `input.parent` and spawn its detached runner, then wait until the runner
	 * says it is running. Refuses what `prepare` refuses.
	 */
	export const start = async (
		deps: StartDeps,
		input: StartInput,
	): Promise<Result<RunStore.Run>> => {
		const prepared = await prepare(deps, input);
		if (!prepared.ok) return prepared;
		const { plan, projectDir, config } = prepared.value;
		const parent = plan.parent;
		const now = (deps.now ?? (() => new Date()))();
		const short = parent.shortId ?? parent.id;
		const created = RunStore.create(deps.home, {
			version: 1,
			id: RunStore.newRunId(short, now),
			parentId: parent.id,
			parentShortId: short,
			...(parent.scopeUri ? { scopeUri: parent.scopeUri } : {}),
			projectDir,
			config,
			status: "pending",
			createdAt: now.toISOString(),
			claims: [],
			usage: {},
			continuationsUsed: 0,
			inboxRead: 0,
			steering: Steering.INITIAL,
			gateRuns: [],
		});
		if (!created.ok) return created;
		const run = config.worktree
			? await withWorktree(deps, created.value)
			: created;
		if (!run.ok) return run;
		tellPlacement(deps.home, run.value);
		const spawned = spawnRunner(deps, run.value);
		if (!spawned.ok) {
			markFailed(
				deps.home,
				run.value,
				"runner-not-spawned",
				spawned.error.message,
			);
			return spawned;
		}
		return awaitBoot(deps, run.value, spawned.value.exited);
	};

	/**
	 * Where a run works, as `start` says it on the run's trace and the CLI prints it; undefined
	 * for a run told to work in place.
	 */
	export const placement = (run: RunStore.Run): string | undefined => {
		if (run.worktreeReused)
			return `worktree ${run.worktree}, run ${run.worktreeReused.runId}'s: its branch ${run.worktreeReused.branch} is not merged into HEAD, so this run goes on with it`;
		if (run.worktree)
			return `worktree ${run.worktree}, new, on branch ${Worktree.branchFor(run.id)} from HEAD`;
		return run.config.worktree
			? `in place in ${run.projectDir}: it is not a git repository, so the run has no worktree`
			: undefined;
	};

	// Before the runner is spawned, so the trace's one writer is still `start`.
	const tellPlacement = (home: string, run: RunStore.Run): void => {
		const summary = placement(run);
		const log = RunStore.eventLog(home, run.id);
		if (summary === undefined || !log.ok) return;
		log.value.append({
			type: "workspace",
			summary,
			data: {
				dir: RunStore.sessionDir(run),
				...(run.worktreeReused
					? {
							reusedFrom: run.worktreeReused.runId,
							branch: run.worktreeReused.branch,
						}
					: {}),
			},
		});
	};

	// The parent's last run's worktree, when the new run should go on in it: still one of the
	// repository's worktrees, no live run working in it, and its branch not merged into HEAD, so
	// what was done there is not in a fresh worktree of HEAD. `checkParent` has refused a parent
	// whose last run is live or lost its runner: that run is restarted, not taken over.
	const reusable = async (
		deps: StartDeps,
		run: RunStore.Run,
	): Promise<
		Result<
			| {
					dir: string;
					from: { runId: string; branch: string };
					base?: Worktree.Head;
			  }
			| undefined
		>
	> => {
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const others = runs.value.filter((r) => r.id !== run.id);
		// Newest first: the parent's last run.
		const last = others.find((r) => r.parentId === run.parentId);
		const dir = last?.worktree;
		if (
			last === undefined ||
			dir === undefined ||
			others.some((r) => r.worktree === dir && RunStore.isLive(r.status))
		)
			return ok(undefined);
		const branch = await Worktree.branchOf(run.projectDir, dir, deps.git);
		if (!branch.ok) return branch;
		if (branch.value === undefined) return ok(undefined);
		const merged = await Worktree.merged(
			run.projectDir,
			branch.value,
			deps.git,
		);
		if (!merged.ok) return merged;
		return ok(
			merged.value
				? undefined
				: {
						dir,
						from: { runId: last.id, branch: branch.value },
						...(last.base ? { base: last.base } : {}),
					},
		);
	};

	// The run's worktree, beside its files: the parent's last run's when its branch is not merged
	// (`reusable`), else a new one of the project's HEAD, in which what is not committed in the
	// project (work in progress) is not. A loop started in a folder of the repository works in
	// that folder of the worktree. A project that is not a git repository is worked in place.
	const withWorktree = async (
		deps: StartDeps,
		run: RunStore.Run,
	): Promise<Result<RunStore.Run>> => {
		if (!Worktree.inRepo(run.projectDir)) return ok(run);
		const failed = (error: Error): Result<RunStore.Run> => {
			markFailed(deps.home, run, "worktree-not-created", error.message);
			return err(error);
		};
		const prefix = await Worktree.prefixOf(run.projectDir, deps.git);
		if (!prefix.ok) return failed(prefix.error);
		const reused = await reusable(deps, run);
		if (!reused.ok) return failed(reused.error);
		// What the run lands onto: the project's HEAD now, or the base of the worktree it goes on in.
		const base = reused.value?.base
			? ok(reused.value.base)
			: await Worktree.head(run.projectDir, deps.git);
		if (!base.ok) return failed(base.error);
		if (reused.value) {
			const { dir, from } = reused.value;
			if (!existsSync(join(dir, prefix.value)))
				return failed(
					new Error(
						`${prefix.value} is not in run ${from.runId}'s worktree ${dir}, which this run would go on in: start from where that run was started, or with --no-worktree`,
					),
				);
			return RunStore.write(deps.home, {
				...run,
				worktree: dir,
				worktreePrefix: prefix.value,
				worktreeReused: from,
				base: base.value,
			});
		}
		const dir = Worktree.dirFor(RunStore.paths(deps.home, run.id).dir);
		// Checked before the worktree is added, so a refusal leaves no worktree or branch behind.
		if (
			prefix.value !== "" &&
			!(await Worktree.has(run.projectDir, prefix.value, deps.git))
		)
			return failed(
				new Error(
					`${prefix.value} is not committed, so a worktree of HEAD would not have it: commit it, or start with --no-worktree`,
				),
			);
		const added = await Worktree.add(
			run.projectDir,
			dir,
			Worktree.branchFor(run.id),
			deps.git,
		);
		if (!added.ok) return failed(added.error);
		const withDir: RunStore.Run = {
			...run,
			worktree: dir,
			worktreePrefix: prefix.value,
			base: base.value,
		};
		return RunStore.write(deps.home, withDir);
	};

	/**
	 * Start run `runId` again in a detached runner, after its runner died, and wait until the new
	 * one reports: what `kabane loop resume` does to such a run. The runner (`Runner.run`) closes
	 * the claims the dead one left open, releases their subtasks and goes on where it stopped.
	 * Refused for any other run, and while another run on the same parent is live.
	 */
	export const restart = async (
		deps: SpawnDeps,
		runId: string,
	): Promise<Result<RunStore.Run>> => {
		const read = RunStore.read(deps.home, runId);
		if (!read.ok) return read;
		const dead = read.value;
		if (!died(dead))
			return err(
				new Error(
					`Run ${runId} is ${dead.status}: only a run whose runner died restarts`,
				),
			);
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const rival = liveRunOn(runs.value, dead.parentId, runId);
		if (rival)
			return err(
				new Error(
					`Run ${runId} cannot restart: ${dead.parentShortId} already has a live loop run, ${rival.id}; stop it first`,
				),
			);
		const spawned = spawnRunner(deps, dead);
		if (!spawned.ok) return spawned;
		return awaitBoot(deps, dead, spawned.value.exited);
	};

	export type RunDeps = Deps & {
		overrides?: Partial<Record<Harnesses.Id, Harnesses.Overrides>>;
		/** The device config's `harness.mode`. */
		mode?: Harnesses.Mode;
	};

	/**
	 * Drive a run in this process until it ends: what the detached `kabane loop run <runId>`
	 * does. SIGTERM and SIGINT stop it the way `stop` does, so its sessions are closed and
	 * its subtasks released rather than left in progress.
	 */
	export const run = async (
		deps: RunDeps,
		runId: string,
	): Promise<Result<RunStore.Run>> => {
		const controller = new AbortController();
		const onSignal = () => controller.abort();
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
		try {
			return await Runner.run(runId, {
				...deps,
				pid: process.pid,
				signal: controller.signal,
			});
		} finally {
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
		}
	};

	/** One run as it is now: a run whose runner is gone reads as failed. */
	export const status = (
		deps: Pick<Deps, "home">,
		runId: string,
	): Result<RunStore.Run> => RunStore.read(deps.home, runId);

	/** Every run on this device, newest first. */
	export const list = (deps: Pick<Deps, "home">): Result<RunStore.Run[]> =>
		RunStore.list(deps.home);

	/** A question one of a run's sessions is blocked on. */
	export type Waiting = {
		questionId: string;
		task: string;
		question: string;
		choices: string[];
	};

	const waitingOf = (question: AgentActivity, task: string): Waiting => {
		const parsed = parseQuestionBody(question.body);
		return {
			questionId: question.id,
			task,
			question: parsed.question,
			choices: parsed.choices,
		};
	};

	/** The questions run `runId`'s sessions are waiting on a human for, from core. */
	export const questions = async (
		deps: Pick<Deps, "basePath">,
		runId: string,
	): Promise<Result<Waiting[]>> => {
		const needs = await Planner.getNeedsInput(deps.basePath);
		if (!needs.ok) return needs;
		return ok(
			needs.value.flatMap(({ session, task, question }) =>
				question && session.externalRef === RunStore.sessionRef(runId)
					? [waitingOf(question, task?.shortId ?? session.taskId)]
					: [],
			),
		);
	};

	/**
	 * Withdraw what the sessions of `run`, whose runner died, were asking. Their harnesses died with
	 * the runner, so nobody is left to read an answer, and a restart closes those sessions and asks
	 * again in new ones. Each question nothing answers is closed as `withdrawn` (`Questions.withdraw`)
	 * and the session ended after it, since core takes no activity on an ended one. That closes the
	 * question on every surface: the needs-input queue and the open questions a task's detail
	 * shows, which reads ended sessions too. Returns the questions withdrawn, for `status` to show,
	 * on this call or an earlier one; nothing for a run whose runner is not dead. Whichever surface
	 * first sees the death does this: the dead runner cannot. A question that cannot be closed
	 * leaves its session open, so the next call tries again.
	 */
	export const withdraw = async (
		deps: Pick<Deps, "basePath">,
		run: RunStore.Run,
	): Promise<Result<Waiting[]>> => {
		if (!died(run)) return ok([]);
		const death = `the loop runner of ${run.id} died; \`${restartCommand(run.id)}\` restarts the run`;
		const why = `withdrawn: ${death}, and its agent asks again`;
		const withdrawn: Waiting[] = [];
		for (const claim of run.claims) {
			if (claim.endedAt !== undefined) continue;
			const { sessionId } = claim;
			const before = await Planner.getActivities(deps.basePath, sessionId);
			if (!before.ok) return before;
			const open = strandedBy(before.value, why);
			const failed: string[] = [];
			await Questions.withdraw(
				{
					basePath: deps.basePath,
					sessionId,
					emit: (warning) => failed.push(warning.summary),
				},
				open.map((q) => q.id),
				why,
			);
			if (failed.length > 0) return err(new Error(failed.join("; ")));
			const ended = await Planner.endSession(deps.basePath, sessionId, {
				state: "error",
				summary: death,
			});
			if (!ended.ok) return ended;
			for (const q of open) withdrawn.push(waitingOf(q, claim.shortId));
		}
		return ok(withdrawn);
	};

	// The questions the runner's death leaves unanswered: nothing closes them yet, or only the
	// withdrawal `why` an earlier call wrote for that death.
	const strandedBy = (
		activities: readonly AgentActivity[],
		why: string,
	): AgentActivity[] =>
		activities.filter(
			(q) =>
				q.type === "question" &&
				activities
					.filter((a) => isAnswerTo(a.context, q.id))
					.every((a) => a.type === "withdrawn" && a.body === why),
		);

	/** The run whose runner died while one of its sessions asked `questionId`, withdrawing it. */
	const stranded = async (
		deps: Pick<Deps, "home" | "basePath">,
		questionId: string,
	): Promise<Result<RunStore.Run | undefined>> => {
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		for (const run of runs.value.filter(died)) {
			const withdrawn = await withdraw(deps, run);
			if (!withdrawn.ok) return withdrawn;
			if (withdrawn.value.some((q) => q.questionId === questionId))
				return ok(run);
		}
		return ok(undefined);
	};

	const strandedError = (run: RunStore.Run, questionId: string): Error =>
		new Error(
			`Question ${questionId} was asked in run ${run.id}, whose runner died, so nobody is left to read an answer: \`${restartCommand(run.id)}\` restarts the run, and its agent asks again`,
		);

	// The decision's body for `given`: the label of the option it names, or for a multi-select
	// the labels of the ones it names, comma-separated. A permission question takes only the
	// harness's options; another question also takes free text when it allows it.
	const answerText = (
		question: ParsedQuestion,
		given: string,
	): Result<string> => {
		const options =
			question.permission?.options ??
			question.choices.map((label) => ({ label }));
		const chosen = question.multiSelect
			? Elicitation.chooseMany(options, given)
			: [Permission.choose(options, given)].filter((o) => o !== undefined);
		if (chosen && chosen.length > 0)
			return ok(chosen.map((o) => o.label).join(", "));
		if (!question.permission && question.allowFreeform) return ok(given);
		const listed = options.map((o, i) => `${i + 1}. ${o.label}`).join(", ");
		return err(
			new Error(`"${given}" is none of this question's options: ${listed}`),
		);
	};

	export type Answered = {
		questionId: string;
		answer: string;
		runId: string;
		task: string;
	};

	/**
	 * Answer a question a loop session is waiting on, as `actor`, through `Planner.answerQuestion`:
	 * the same answer the board gives. A permission question takes one of the harness's options
	 * by id, label or position, and the decision records its label.
	 */
	type AnswerDeps = Pick<Deps, "home" | "basePath"> & { actor: string };

	type Asked = { question: AgentActivity; runId: string; task: string };

	/** The question `questionId`, the run whose session waits on it, and its task; undefined if no loop's. */
	const waiting = async (
		basePath: string,
		questionId: string,
	): Promise<Result<Asked | undefined>> => {
		const needs = await Planner.getNeedsInput(basePath);
		if (!needs.ok) return needs;
		const row = needs.value.find((r) => r.question?.id === questionId);
		const runId = RunStore.runOfSession(row?.session.externalRef);
		return ok(
			row?.question && runId !== undefined
				? {
						question: row.question,
						runId,
						task: row.task?.shortId ?? row.session.taskId,
					}
				: undefined,
		);
	};

	// Who answered also rides the run's inbox, noted before the answer so the runner finds it
	// once it sees the answer.
	const note = (
		deps: AnswerDeps,
		runId: string,
		questionId: string,
	): Result<void> =>
		RunStore.appendInbox(deps.home, runId, {
			kind: "answered",
			questionId,
			by: deps.actor,
			at: new Date().toISOString(),
		});

	/**
	 * Note that `deps.actor` is answering `questionId`, when a loop session waits on it: what the
	 * board does before it writes an answer of its own. Any other question is not the loop's to note.
	 * A question of a run whose runner died is withdrawn and refused, as `answer` refuses it.
	 */
	export const answering = async (
		deps: AnswerDeps,
		questionId: string,
	): Promise<Result<void>> => {
		const dead = await stranded(deps, questionId);
		if (!dead.ok) return dead;
		if (dead.value) return err(strandedError(dead.value, questionId));
		const found = await waiting(deps.basePath, questionId);
		if (!found.ok) return found;
		return found.value
			? note(deps, found.value.runId, questionId)
			: ok(undefined);
	};

	export const answer = async (
		deps: AnswerDeps,
		questionId: string,
		given: string,
	): Promise<Result<Answered>> => {
		const dead = await stranded(deps, questionId);
		if (!dead.ok) return dead;
		if (dead.value) return err(strandedError(dead.value, questionId));
		const found = await waiting(deps.basePath, questionId);
		if (!found.ok) return found;
		if (!found.value)
			return err(
				new Error(
					`No loop session is waiting on question ${questionId}: it is answered, its session ended, or the id is wrong. \`kabane loop status <runId>\` lists the open ones`,
				),
			);
		const { question, runId, task } = found.value;
		const text = answerText(parseQuestionBody(question.body), given);
		if (!text.ok) return text;
		// A note that cannot be written (the run's directory is gone) does not hold the answer back.
		note(deps, runId, questionId);
		const answered = await Planner.answerQuestion(deps.basePath, {
			questionId,
			answer: text.value,
		});
		if (!answered.ok) return answered;
		return ok({ questionId, answer: text.value, runId, task });
	};

	const liveRun = (home: string, runId: string): Result<RunStore.Run> => {
		const run = RunStore.read(home, runId);
		if (!run.ok) return run;
		if (RunStore.isLive(run.value.status)) return run;
		return err(
			died(run.value)
				? diedError(run.value)
				: new Error(`Run ${runId} is ${run.value.status}`),
		);
	};

	/** Stop or restart claiming on a live run; sessions already running finish either way. */
	export const pause = (
		deps: Pick<Deps, "home">,
		runId: string,
		kind: "pause" | "resume",
	): Result<RunStore.Run> => {
		const run = liveRun(deps.home, runId);
		if (!run.ok) return run;
		const asked = RunStore.appendInbox(deps.home, runId, {
			kind,
			at: new Date().toISOString(),
		});
		return asked.ok ? run : asked;
	};

	export type Directed = { runId: string; task: string };

	// Whether `task` is in `run`'s plan for a human to steer: a child of its target, or the target
	// itself while the run works it as a single issue. A parent is never claimed, so skipping it
	// would steer nothing.
	const steerable = async (
		basePath: string,
		run: RunStore.Run,
		task: Task,
		short: string,
	): Promise<Result<void>> => {
		if (task.parentTaskId === run.parentId) return ok(undefined);
		const plan = await LoopPlan.load(basePath, run.parentId);
		if (!plan.ok) return plan;
		const single = LoopPlan.single(plan.value);
		if (task.id === run.parentId)
			return single
				? ok(undefined)
				: err(
						new Error(
							`${short} is the parent run ${run.id} works the subtasks of: skip or next one of them`,
						),
					);
		return err(
			new Error(
				single
					? `${short} is not ${run.parentShortId}, the single issue run ${run.id} works`
					: `${short} is not a subtask of ${run.parentShortId}`,
			),
		);
	};

	/**
	 * Never claim `task` (`skip`), or claim it ahead of the rest once it is ready (`next`), in the
	 * live run whose plan it is in: the run on its parent, else a run on the task itself as a
	 * single issue. `runId` names that run when the caller knows it.
	 */
	export const direct = async (
		deps: Pick<Deps, "home" | "basePath">,
		kind: "skip" | "next",
		task: string,
		runId?: string,
	): Promise<Result<Directed>> => {
		const id = await Planner.resolveTaskId(deps.basePath, task);
		if (!id.ok) return id;
		const found = await Planner.getTask(deps.basePath, id.value);
		if (!found.ok) return found;
		if (!found.value) return err(new Error(`No task ${task}`));
		const target = found.value;
		const short = target.shortId ?? target.id;
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const onParent = target.parentTaskId
			? liveRunOn(runs.value, target.parentTaskId)
			: undefined;
		const run =
			runId === undefined
				? (onParent ?? liveRunOn(runs.value, target.id))
				: runs.value.find((r) => r.id === runId);
		if (!run)
			return err(
				new Error(
					runId === undefined
						? `No live loop run is working on ${short}${target.parentTaskId ? " or its parent" : ""}`
						: `No loop run ${runId}`,
				),
			);
		const inPlan = await steerable(deps.basePath, run, target, short);
		if (!inPlan.ok) return inPlan;
		const live = liveRun(deps.home, run.id);
		if (!live.ok) return live;
		const asked = RunStore.appendInbox(deps.home, run.id, {
			kind,
			at: new Date().toISOString(),
			taskId: target.id,
			task: short,
		});
		return asked.ok ? ok({ runId: run.id, task: short }) : asked;
	};

	export type RolledBack = { runId: string; sha: string; worktree: string };

	/**
	 * Reset run `runId`'s worktree to one of its checkpoints, named by its sha or a prefix of it.
	 * Refused for a sha that is not one of the run's checkpoints, for a run with no worktree, and
	 * while a session is working in it (pause the run and let them finish, or stop it). The
	 * tracker is not rolled back: subtasks closed after the checkpoint stay closed.
	 */
	export const rollback = async (
		deps: Pick<Deps, "home"> & { actor: string; git?: Worktree.Git },
		runId: string,
		given: string,
	): Promise<Result<RolledBack>> => {
		const read = RunStore.read(deps.home, runId);
		if (!read.ok) return read;
		const run = read.value;
		if (run.worktree === undefined)
			return err(
				new Error(
					`Run ${runId} has no worktree, so it has no checkpoints to roll back to`,
				),
			);
		const sha = Worktree.match(RunStore.checkpoints(run), given);
		if (!sha.ok) return sha;
		const live = RunStore.isLive(run.status);
		const working = run.claims.filter((c) => c.endedAt === undefined);
		if (live && working.length > 0)
			return err(
				new Error(
					`${working.map((c) => c.lane).join(", ")} still working in ${run.worktree}: pause the run and let them finish, or stop it`,
				),
			);
		const reset = await Worktree.reset(run.worktree, sha.value, deps.git);
		if (!reset.ok) return reset;
		const at = new Date().toISOString();
		// The trace is the runner's to write while it is live; it puts the note there itself.
		if (live)
			RunStore.appendInbox(deps.home, runId, {
				kind: "rolled_back",
				sha: sha.value,
				by: deps.actor,
				at,
			});
		else {
			const log = RunStore.eventLog(deps.home, runId);
			if (log.ok) log.value.append(Worktree.rolledBack(sha.value, deps.actor));
		}
		return ok({ runId, sha: sha.value, worktree: run.worktree });
	};

	/**
	 * Ask a run to stop and wait for it to wind down. A live runner hears it through the inbox,
	 * cancels its sessions and releases their subtasks. A run with no runner (one that never
	 * booted) is marked stopped here, since nobody else will. A run that is over is returned as is.
	 */
	export const stop = async (
		deps: Pick<Deps, "home"> & { waitMs?: number },
		runId: string,
	): Promise<Result<RunStore.Run>> => {
		const before = RunStore.read(deps.home, runId);
		if (!before.ok || !RunStore.isLive(before.value.status)) return before;
		const asked = RunStore.appendInbox(deps.home, runId, {
			kind: "stop",
			at: new Date().toISOString(),
		});
		if (!asked.ok) return asked;
		if (before.value.pid === undefined)
			return RunStore.write(deps.home, {
				...before.value,
				status: "stopped",
				exit: {
					reason: "stop-requested",
					detail: "the runner had not started",
				},
				endedAt: new Date().toISOString(),
			});
		const deadline = Date.now() + (deps.waitMs ?? STOP_WAIT_MS);
		for (;;) {
			const now = RunStore.read(deps.home, runId);
			if (
				!now.ok ||
				!RunStore.isLive(now.value.status) ||
				Date.now() >= deadline
			)
				return now;
			await sleep(POLL_MS * 5);
		}
	};
}
