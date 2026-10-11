// The loop's entry points, as plain functions over explicit dependencies. The extension wires
// them to `kabane loop start|run|status|stop|pause|resume|skip|next|rollback|answer`; nothing here parses argv or reads the
// environment for its own settings.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Harnesses } from "@cabane/acp";
import {
	err,
	ok,
	type AgentActivity,
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
import { LoopConfig } from "./config";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
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
	};

	export type StartInput = {
		/** The parent issue: id or short id. */
		parent: string;
		/**
		 * The project checkout to work on, relative to `cwd`. Absent, it is `cwd`, which must
		 * then be the parent issue's scope. Its `.kabane/loop.json` is layered into the config.
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

	/** Spawn the runner detached from this process, its output going to the run's log. */
	const spawnRunner = (
		deps: StartDeps,
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

	const awaitBoot = async (
		deps: StartDeps,
		run: RunStore.Run,
		exited: () => number | null | undefined,
	): Promise<Result<RunStore.Run>> => {
		const deadline = Date.now() + (deps.bootMs ?? BOOT_MS);
		while (Date.now() < deadline) {
			const now = RunStore.read(deps.home, run.id);
			if (now.ok && now.value.status !== "pending") return now;
			if (exited() !== undefined) {
				const detail = `the runner exited (${exited()}) before it started: ${logTail(deps.home, run.id)}`;
				markFailed(deps.home, run, "runner-exited", detail);
				return err(new Error(detail));
			}
			await sleep(POLL_MS);
		}
		const detail = `the runner did not report within ${deps.bootMs ?? BOOT_MS} ms; see ${RunStore.paths(deps.home, run.id).log}`;
		return err(new Error(detail));
	};

	// The parent must have something for a run to do (open work, or checks to run on work that
	// is done) and no live run already.
	const checkParent = async (
		deps: Pick<StartDeps, "home">,
		plan: LoopPlan.Plan,
		config: LoopConfig.Config,
		projectDir: string,
	): Promise<Result<void>> => {
		const short = plan.parent.shortId ?? plan.parent.id;
		if (!plan.nodes.some(LoopPlan.isWork))
			return err(new Error(`${short} has no subtasks for a loop to run`));
		if (
			Stop.workDone(plan) &&
			!Gates.configured(config.gates) &&
			config.lenses.length === 0
		)
			return err(
				new Error(
					`Every subtask of ${short} is already closed and no gates or lenses are configured to check it`,
				),
			);
		// A lens with no prompt would fail the run at its end; say so before it starts.
		for (const name of config.lenses) {
			const prompt = Lenses.prompt(projectDir, name);
			if (!prompt.ok) return prompt;
		}
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const active = runs.value.find(
			(r) => r.parentId === plan.parent.id && RunStore.isLive(r.status),
		);
		return active
			? err(new Error(`${short} already has a live loop run: ${active.id}`))
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
		deps: Pick<StartDeps, "home" | "basePath" | "cwd">,
		input: StartInput,
	): Promise<Result<Prepared>> => {
		const parentId = await Planner.resolveTaskId(deps.basePath, input.parent);
		if (!parentId.ok) return parentId;
		const plan = await LoopPlan.load(deps.basePath, parentId.value);
		if (!plan.ok) return plan;
		const projectDir = await projectDirFor(deps, plan.value.parent, input.dir);
		if (!projectDir.ok) return projectDir;
		const config = LoopConfig.resolve(projectDir.value, input.config);
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

	// The run's own worktree of the project's HEAD, beside its files. What is not committed in the
	// project (work in progress) is not in it. A loop started in a folder of the repository works
	// in that folder of the worktree.
	const withWorktree = async (
		deps: StartDeps,
		run: RunStore.Run,
	): Promise<Result<RunStore.Run>> => {
		const failed = (error: Error): Result<RunStore.Run> => {
			markFailed(deps.home, run, "worktree-not-created", error.message);
			return err(error);
		};
		const prefix = await Worktree.prefixOf(run.projectDir, deps.git);
		if (!prefix.ok) return failed(prefix.error);
		const dir = Worktree.dirFor(RunStore.paths(deps.home, run.id).dir);
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
		};
		if (!existsSync(RunStore.sessionDir(withDir)))
			return failed(
				new Error(
					`${prefix.value} is not committed, so the worktree of HEAD at ${dir} has no such folder: commit it, or start without --worktree`,
				),
			);
		return RunStore.write(deps.home, withDir);
	};

	export type RunDeps = Deps & {
		overrides?: Partial<Record<Harnesses.Id, Harnesses.Overrides>>;
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

	/** The questions run `runId`'s sessions are waiting on a human for, from core. */
	export const questions = async (
		deps: Pick<Deps, "basePath">,
		runId: string,
	): Promise<Result<Waiting[]>> => {
		const needs = await Planner.getNeedsInput(deps.basePath);
		if (!needs.ok) return needs;
		return ok(
			needs.value.flatMap(({ session, task, question }) => {
				if (!question || session.externalRef !== RunStore.sessionRef(runId))
					return [];
				const parsed = parseQuestionBody(question.body);
				return [
					{
						questionId: question.id,
						task: task?.shortId ?? session.taskId,
						question: parsed.question,
						choices: parsed.choices,
					},
				];
			}),
		);
	};

	// The decision's body for `given`: the label of the option it names. A permission question
	// takes only the harness's options; another question also takes free text when it allows it.
	const answerText = (
		question: ParsedQuestion,
		given: string,
	): Result<string> => {
		const options =
			question.permission?.options ??
			question.choices.map((label) => ({ label }));
		const chosen = Permission.choose(options, given);
		if (chosen) return ok(chosen.label);
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

	// Core records no author on an activity, so who answered rides the run's inbox, noted before
	// the answer so the runner finds it once it sees the decision.
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
	 */
	export const answering = async (
		deps: AnswerDeps,
		questionId: string,
	): Promise<Result<void>> => {
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
		return RunStore.isLive(run.value.status)
			? run
			: err(new Error(`Run ${runId} is ${run.value.status}`));
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

	/**
	 * Never claim subtask `task` (`skip`), or claim it ahead of the rest once it is ready
	 * (`next`), in the live run on its parent; `runId` names that run when the caller knows it.
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
		const subtask = found.value;
		const short = subtask.shortId ?? subtask.id;
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const run = runs.value.find((r) =>
			runId === undefined
				? r.parentId === subtask.parentTaskId && RunStore.isLive(r.status)
				: r.id === runId,
		);
		if (!run)
			return err(
				new Error(
					runId === undefined
						? `No live loop run is working on ${short}'s parent`
						: `No loop run ${runId}`,
				),
			);
		if (run.parentId !== subtask.parentTaskId)
			return err(
				new Error(`${short} is not a subtask of ${run.parentShortId}`),
			);
		const live = liveRun(deps.home, run.id);
		if (!live.ok) return live;
		const asked = RunStore.appendInbox(deps.home, run.id, {
			kind,
			at: new Date().toISOString(),
			taskId: subtask.id,
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
