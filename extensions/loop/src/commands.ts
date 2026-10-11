// The loop's entry points, as plain functions over explicit dependencies. The extension wires
// them to `kabane loop start|run|status|stop|answer`; nothing here parses argv or reads the
// environment for its own settings.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Harnesses } from "@cabane/acp";
import {
	err,
	ok,
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
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import { Stop } from "./stop";
import { RunStore } from "./store";

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

	// The parent must have open work and no live run already.
	const checkParent = async (
		deps: Pick<StartDeps, "home">,
		plan: LoopPlan.Plan,
	): Promise<Result<void>> => {
		const short = plan.parent.shortId ?? plan.parent.id;
		if (!plan.nodes.some(LoopPlan.isWork))
			return err(new Error(`${short} has no subtasks for a loop to run`));
		if (Stop.evaluate(plan).done)
			return err(new Error(`Every subtask of ${short} is already closed`));
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
	 * board's trigger shows before the human starts it. Refuses a parent with no open work, one
	 * that already has a live run, and a directory that is not the parent's scope (unless
	 * `input.dir` names it).
	 */
	export const prepare = async (
		deps: Pick<StartDeps, "home" | "basePath" | "cwd">,
		input: StartInput,
	): Promise<Result<Prepared>> => {
		const parentId = await Planner.resolveTaskId(deps.basePath, input.parent);
		if (!parentId.ok) return parentId;
		const plan = await LoopPlan.load(deps.basePath, parentId.value);
		if (!plan.ok) return plan;
		const checked = await checkParent(deps, plan.value);
		if (!checked.ok) return checked;
		const projectDir = await projectDirFor(deps, plan.value.parent, input.dir);
		if (!projectDir.ok) return projectDir;
		const config = LoopConfig.resolve(projectDir.value, input.config);
		if (!config.ok) return config;
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
		});
		if (!created.ok) return created;
		const spawned = spawnRunner(deps, created.value);
		if (!spawned.ok) {
			markFailed(
				deps.home,
				created.value,
				"runner-not-spawned",
				spawned.error.message,
			);
			return spawned;
		}
		return awaitBoot(deps, created.value, spawned.value.exited);
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
	export const answer = async (
		deps: Pick<Deps, "home" | "basePath"> & { actor: string },
		questionId: string,
		given: string,
	): Promise<Result<Answered>> => {
		const needs = await Planner.getNeedsInput(deps.basePath);
		if (!needs.ok) return needs;
		const row = needs.value.find((r) => r.question?.id === questionId);
		const runId = RunStore.runOfSession(row?.session.externalRef);
		if (!row?.question || runId === undefined)
			return err(
				new Error(
					`No loop session is waiting on question ${questionId}: it is answered, its session ended, or the id is wrong. \`kabane loop status <runId>\` lists the open ones`,
				),
			);
		const text = answerText(parseQuestionBody(row.question.body), given);
		if (!text.ok) return text;
		// Core records no author on an activity, so who answered rides the run's inbox, noted
		// before the answer so the runner finds it once it sees the decision. A note that cannot
		// be written (the run's directory is gone) does not hold the answer back.
		RunStore.appendInbox(deps.home, runId, {
			kind: "answered",
			questionId,
			by: deps.actor,
			at: new Date().toISOString(),
		});
		const answered = await Planner.answerQuestion(deps.basePath, {
			questionId,
			answer: text.value,
		});
		if (!answered.ok) return answered;
		return ok({
			questionId,
			answer: text.value,
			runId,
			task: row.task?.shortId ?? row.session.taskId,
		});
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
