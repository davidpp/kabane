// A claim's life in the tracker: open a core session on the subtask, move it to in_progress,
// log the session on it, dispatch; when the session ends with the subtask done, run the gates
// while the claim still holds it; then close the core session, put a subtask the agent left in
// progress and still owned back in the ready pool, record the gates, end the claim, and take a
// progress mark for the stall detector unless the tracker parked or handed off the work. A lens
// is a claim on the parent that leaves its state alone and has no gates; so is a lens's recheck of
// the fixer's diff, and the fixer, whose gates the runner runs once it has ended. A runner that died mid-claim leaves claims with no
// end; `recover` closes them, finishing a done subtask's gates, and the claim that takes the work
// over continues the interrupted one: its harness session resumed where the harness can, told what
// that attempt left either way. A subtask its own red gate reopened is claimed again in the session
// that closed it, while `Retry` says that session has room, and in a new one told the gate's output
// otherwise. A subtask closed with checklist items open gets no pass: it is reopened.
import type { Harnesses } from "@cabane/acp";
import { err, ok, Planner, type Result, type Task } from "@cabane/core";
import type { Brief } from "./brief";
import { Budget } from "./budget";
import { Checklists } from "./checklists";
import { Checks } from "./checks";
import { Dispatch } from "./dispatch";
import { Elicitation } from "./elicitation";
import { Fixer } from "./fixer";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import type { Questions } from "./questions";
import { Retry } from "./retry";
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

	// A lens, a recheck and the fixer hold the parent without taking it: its state is never theirs to
	// release.
	const onParent = RunStore.reviews;

	export const mark = async (ctx: Ctx, plan: LoopPlan.Plan): Promise<string> =>
		Stall.mark(
			LoopPlan.closed(plan),
			await ctx.tree(RunStore.sessionDir(ctx.run)),
			Gates.signature(ctx.run.gateRuns.at(-1)),
			await Checklists.progress(ctx.deps.basePath, [
				plan.parent.id,
				...plan.nodes.map((n) => n.task.id),
			]),
		);

	// A subtask's pass is recorded before its claim ends (`settle`), so an open claim on a done
	// subtask is one whose runner died between the session closing it and that record: record the
	// pass it already ran, or run the one it never finished.
	const finishPass = async (ctx: Ctx, claim: RunStore.Claim): Promise<void> => {
		const subject = {
			taskId: claim.taskId,
			label: claim.shortId,
			lane: claim.lane,
			harness: claim.harness,
		};
		const pass =
			ctx.run.gateRuns.findLast(
				(r) => r.taskId === claim.taskId && r.at >= claim.startedAt,
			) ?? (await gatesAfter(ctx, subject));
		if (pass)
			await Checks.record(ctx, pass, { ...subject, assignee: claim.harness });
	};

	const EDITED =
		"the recheck changed the working tree, which a recheck must not do: its changes are left in place for a human";

	const treeChanged = async (ctx: Ctx, tree: string): Promise<boolean> =>
		(await ctx.tree(RunStore.sessionDir(ctx.run))) !== tree;

	// An open recheck whose tree is no longer the one its lens's first recheck started on edited
	// files before its runner died: it failed, rather than being interrupted, and the run stops on
	// it at boot, before a claim or a gate pass could commit those edits as a checkpoint.
	const recheckEdited = async (
		ctx: Ctx,
		claim: RunStore.Claim,
	): Promise<boolean> => {
		if (claim.recheck === undefined) return false;
		const tree = ctx.run.claims.find((c) => c.recheck === claim.recheck)?.tree;
		return tree !== undefined && treeChanged(ctx, tree);
	};

	/**
	 * Close the claims a runner that died left open, finishing the pass a subtask's was owed. Why
	 * the run must stop, when one was a recheck that had edited files; undefined otherwise.
	 */
	export const recover = async (ctx: Ctx): Promise<string | undefined> => {
		let edited: string | undefined;
		const open = ctx.run.claims.filter((c) => c.endedAt === undefined);
		for (const claim of open) {
			const exited = "the runner exited while this session was open";
			await closeSession(ctx, claim.sessionId, {
				outcome: "error",
				detail: exited,
			});
			if (!onParent(claim)) {
				await finishPass(ctx, claim);
				await release(ctx, claim.taskId, claim.harness);
			}
			const failed = await recheckEdited(ctx, claim);
			const ended = failed
				? { outcome: "error" as const, detail: EDITED }
				: { outcome: "interrupted" as const, detail: exited };
			if (failed) edited ??= `${claim.recheck}: error: ${EDITED}`;
			RunState.patchClaim(ctx, claim.sessionId, {
				endedAt: ctx.now().toISOString(),
				...ended,
			});
			RunState.event(ctx, {
				type: "session_end",
				lane: claim.lane,
				session: claim.sessionId,
				task: claim.shortId,
				summary: `${ended.outcome}: ${ended.detail}`,
			});
		}
		return edited;
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

	type Asker = {
		sessionId: string;
		lane: string;
		shortId: string;
		harness: string;
		/** What the session waits on, for the question's context. */
		blockedOn: string;
	};

	const relayDeps = (
		ctx: Ctx,
		stopped: AbortSignal,
		asker: Asker,
	): Questions.Deps => ({
		basePath: ctx.deps.basePath,
		sessionId: asker.sessionId,
		harness: asker.harness,
		origin: `The ${asker.harness} session working on ${asker.shortId} in loop ${ctx.run.id} is blocked on this ${asker.blockedOn} until it is answered.`,
		signal: stopped,
		emit: (draft) =>
			RunState.event(ctx, {
				...draft,
				lane: asker.lane,
				session: asker.sessionId,
				task: asker.shortId,
			}),
		answeredBy: (questionId) => answeredBy(ctx, questionId),
		now: ctx.now,
	});

	/**
	 * What a claim's dispatch reports through. Everything it records about its session, a relayed
	 * permission request or form included, carries the claim's lane, session and task, so it
	 * shows on that agent's lane of the run's tab.
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
		permission: (request, withdrawn, stopped) =>
			Permission.relay(
				relayDeps(ctx, stopped, {
					sessionId,
					lane,
					shortId,
					harness,
					blockedOn: "tool call",
				}),
				request,
				withdrawn,
			),
		// A form: one question per field, on the same terms.
		elicitation: (request, withdrawn, stopped) =>
			Elicitation.relay(
				relayDeps(ctx, stopped, {
					sessionId,
					lane,
					shortId,
					harness,
					blockedOn: "form",
				}),
				request,
				withdrawn,
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
		/** The attempt whose session a gate retry continues. */
		resumes?: Retry.Resume;
		/** The fixer's: the commit HEAD is at as it starts. */
		head?: string;
		/** A recheck's: the working tree's fingerprint it must leave as it found. */
		tree?: string;
	};

	// A recheck reports and never edits; nothing enforces that in the harness, whose settings are
	// the user's, so a tree that changed under it fails it here instead. Its edits stay where they
	// are. Two rechecks running at once share the tree, so one's edit fails both.
	const unedited = async (
		ctx: Ctx,
		tree: string,
		outcome: Dispatch.Outcome,
	): Promise<Dispatch.Outcome> => {
		if (outcome.outcome !== "done" && outcome.outcome !== "incomplete")
			return outcome;
		return (await treeChanged(ctx, tree))
			? { ...outcome, outcome: "error", detail: EDITED }
			: outcome;
	};

	// Record the claim, dispatch its session and hold it live until it has settled.
	const launch = (ctx: Ctx, plan: LoopPlan.Plan, started: Started): void => {
		const {
			task,
			harness,
			lane,
			sessionId,
			work,
			interrupted,
			resumes,
			head,
			tree,
		} = started;
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
					...(work.kind === "fix"
						? {
								fixer: true as const,
								findings: work.findings.map((f) => f.id),
								...(head ? { head } : {}),
							}
						: {}),
					...(work.kind === "recheck"
						? {
								recheck: work.name,
								findings: work.findings.map((f) => f.id),
								...(tree !== undefined ? { tree } : {}),
							}
						: {}),
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
				...(resumes ? { resumes } : {}),
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
		const settled = handle.done.then(async (ended) => {
			const outcome =
				tree === undefined ? ended : await unedited(ctx, tree, ended);
			const gates =
				work.kind === "implement" && outcome.outcome === "done"
					? await gatesAfter(ctx, {
							taskId: task.id,
							label: label(task),
							lane,
							harness,
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

	/**
	 * Claim one ready work node, a subtask or a single issue itself: a core session, a dispatched
	 * ACP session, a live entry.
	 */
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
			!LoopPlan.isWorkOf(plan, task)
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
		const previous = earlier.at(-1);
		const retry = Gates.lastFailure(ctx.run.gateRuns, task.id);
		const interrupted = await interruption(ctx, previous);
		const retryIn =
			retry && previous
				? Retry.session(previous, harness, ctx.run.usage)
				: undefined;
		launch(ctx, plan, {
			task,
			harness,
			lane,
			sessionId,
			work: {
				kind: "implement",
				gates: Object.keys(ctx.run.config.gates),
				concurrent: ctx.run.config.budget.concurrency > 1,
				...(retry ? { retry } : {}),
			},
			summary: `${harness} claims ${label(task)}: ${task.title}`,
			...(interrupted ? { interrupted } : {}),
			...(retryIn?.resume ? { resumes: retryIn } : {}),
		});
		// Whether the harness resumes it is the dispatch's to say; why it was not tried is the run's.
		if (retryIn && !retryIn.resume)
			RunState.event(ctx, {
				type: "warning",
				lane,
				session: sessionId,
				task: label(task),
				summary: `${retryIn.lane}'s session not resumed for a gate retry (${retryIn.why}): a new session gets the full brief`,
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
		// Empty outside a git repository: the run then has no base to recheck the fixes against.
		const head = await git(ctx, ["rev-parse", "HEAD"]);
		launch(ctx, plan, {
			...(interrupted ? { interrupted } : {}),
			...(head ? { head } : {}),
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

	/**
	 * Recheck the fixer's diff through lens `name`, on the run's verifier harness, against
	 * `findings`, the ones of the lens's the fixer closed, or the ones an interrupted recheck had. The diff runs from `base`, the commit the
	 * fixer started from, to the tree as it is, so a run that commits nothing still shows it. An
	 * error when the lens's prompt cannot be read or its session cannot start.
	 */
	export const recheck = async (
		ctx: Ctx,
		name: string,
		findings: readonly Task[],
		base: string,
		plan: LoopPlan.Plan,
	): Promise<Result<void>> => {
		const prompt = Lenses.prompt(ctx.run.projectDir, name);
		if (!prompt.ok) return prompt;
		const harness = ctx.run.config.verifier ?? ctx.run.config.implementer;
		const earlier = ctx.run.claims.filter((c) => c.recheck === name);
		const attempts = earlier.length;
		const lane = `${name}-recheck${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(new Error(`the ${name} lens's recheck did not start`));
		const interrupted = await interruption(ctx, earlier.at(-1));
		// From the lens's first recheck: what an interrupted one edited counts against the next.
		const tree =
			earlier[0]?.tree ?? (await ctx.tree(RunStore.sessionDir(ctx.run)));
		launch(ctx, plan, {
			...(interrupted ? { interrupted } : {}),
			tree,
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: {
				kind: "recheck",
				name,
				prompt: prompt.value,
				findings,
				base,
				diff: await git(ctx, ["diff", "--no-color", "--no-ext-diff", base]),
				gates: Object.keys(ctx.run.config.gates),
			},
			summary: `${harness} rechecks the fixer's diff for ${findings.map(label).join(", ")} through the ${name} lens`,
		});
		return ok(undefined);
	};

	// A session that closed its subtask as done is followed by the gates, while the claim still
	// holds the subtask, so nothing claims it again before its gates have spoken. A worktree run
	// with no gates still takes the pass: it is what commits the subtask's checkpoint, and without
	// one the work stays uncommitted for as long as the agent never commits it itself. A subtask
	// its session closed with checklist items open is not done: it is reopened instead, with no
	// pass, as its session would have had it reopened had it lived to see its turn end. That is
	// settled when the pass's turn comes: with more than one session, it may wait behind another
	// pass, and an item added meanwhile still holds it back.
	const gatesAfter = async (
		ctx: Ctx,
		{
			harness,
			...subject
		}: Omit<Checks.Subject, "title"> & { taskId: string; harness: string },
	) => {
		if (
			!(Gates.configured(ctx.run.config.gates) || ctx.run.worktree) ||
			ctx.stopping.signal.aborted
		)
			return undefined;
		return Checks.gateWhen(ctx, async () => {
			const task = await Planner.getTask(ctx.deps.basePath, subject.taskId);
			if (!task.ok || task.value?.state !== "done") return undefined;
			const reopened = await Checklists.refuseDone(
				ctx.deps.basePath,
				task.value,
				harness,
			);
			const tag = {
				...(subject.lane ? { lane: subject.lane } : {}),
				task: subject.label,
			};
			// Unread, the checklist does not hold back the pass: the gates still speak on the work.
			if (!reopened.ok)
				RunState.event(ctx, {
					...tag,
					type: "warning",
					summary: `checklist of ${subject.label} not read: ${reopened.error.message}`,
				});
			else if (reopened.value.length > 0) {
				RunState.event(ctx, {
					...tag,
					type: "reopened",
					summary: `${subject.label} reopened: closed with ${reopened.value.length} checklist item${reopened.value.length === 1 ? "" : "s"} open`,
				});
				return undefined;
			}
			return { ...subject, title: task.value.title };
		});
	};

	const observeStall = async (
		ctx: Ctx,
		taskId: string,
		claim: RunStore.Claim | undefined,
	): Promise<boolean> => {
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

	/** Close the books on one ended session; true when the run has stalled. */
	export const settle = async (
		ctx: Ctx,
		{ taskId, sessionId, outcome, gates }: RunState.Settled,
	): Promise<boolean> => {
		ctx.live.delete(sessionId);
		const claim = ctx.run.claims.find((c) => c.sessionId === sessionId);
		const review = claim?.lens !== undefined || claim?.recheck !== undefined;
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
		// A lens, and its recheck, runs once per run and files findings rather than closing work:
		// its end is not a step the stall detector should count.
		if (review) return false;
		return observeStall(ctx, taskId, claim);
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
