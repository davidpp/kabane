// A claim's life in the tracker: open a loop session on the subtask, move it to in_progress,
// log the session on it, dispatch; when the session ends with the subtask done, run the gates
// while the claim still holds it; then close the loop session, put a subtask the agent left in
// progress and still owned back in the ready pool, record the gates, end the claim, and take a
// progress mark for the stall detector unless the tracker parked or handed off the work. A lens
// is a claim on the parent that leaves its state alone and has no gates; so is a lens's recheck of
// the fixer's diff, and the fixer, whose gates the runner runs once it has ended. A runner that died mid-claim leaves claims with no
// end; `recover` closes them, finishing a done subtask's gates, and the claim that takes the work
// over continues the interrupted one: its harness session resumed where the harness can, told what
// that attempt left either way. A subtask its own red gate reopened is claimed again in the session
// that closed it, while `Retry` says that session has room, and in a new one told the gate's output
// otherwise. A subtask closed with checklist items open gets no pass: it is reopened. With
// isolated claims, a subtask works in a worktree of its own (`ClaimTrees`), its session, gates
// and checkpoint there, and a green pass merges its branch into the run's; one the tracker closed
// or cancelled while it held that worktree is settled there (`settleHeld`).
import { Harnesses } from "@kabane/acp/harnesses";
import { type Result, type Task } from "@kabane/core";
import { Brief } from "./brief";
import { Budget } from "./budget";
import { Checklists } from "./checklists";
import { Checks } from "./checks";
import { LoopConfig } from "./config";
import { Dispatch } from "./dispatch";
import { Elicitation } from "./elicitation";
import { Fixer } from "./fixer";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { Permission } from "./permission";
import { LoopPlan } from "./plan";
import type { Questions } from "./questions";
import { err, ok } from "./result";
import { Retry } from "./retry";
import { Review } from "./review";
import { Route } from "./route";
import { Stall } from "./stall";
import { RunState } from "./state";
import { RunStore } from "./store";
import { ClaimTrees } from "./trees";
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
		const task = await ctx.deps.host.record.get({ id: taskId });
		if (!task.ok || !task.value || !LoopPlan.isActive(task.value, harness))
			return;
		const reset = await ctx.deps.host.record.edit({
			id: taskId,
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
		const claim = ctx.run.claims.find((c) => c.sessionId === sessionId);
		const summary = outcome.summary;
		if (!claim || !summary) return;
		const ended = await ctx.deps.host.record.comment({
			id: claim.taskId,
			body: summary,
			kind: "outcome.summary",
		});
		if (!ended.ok)
			RunState.event(ctx, {
				type: "warning",
				session: sessionId,
				summary: `summary not recorded: ${ended.error.message}`,
			});
	};

	// A lens, a recheck and the fixer hold the parent without taking it: its state is never theirs to
	// release.
	const onParent = RunStore.reviews;

	// Every tree the run's sessions work in: its own, and its subtasks' (`ClaimTrees`).
	const trees = async (ctx: Ctx): Promise<string> =>
		(
			await Promise.all(
				[RunStore.sessionDir(ctx.run), ...ClaimTrees.projectDirs(ctx.run)].map(
					(dir) => ctx.tree(dir),
				),
			)
		).join(",");

	export const mark = async (ctx: Ctx, plan: LoopPlan.Plan): Promise<string> =>
		Stall.mark(
			LoopPlan.closed(plan),
			await trees(ctx),
			Gates.signature(ctx.run.gateRuns.at(-1)),
			await Checklists.progress(ctx.deps.host, [
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
			) ?? (await gatesAfter(ctx, subject, heldBy(ctx, claim)));
		if (pass)
			await Checks.record(ctx, pass, { ...subject, assignee: claim.harness });
	};

	const EDITED =
		"the recheck changed the working tree, which a recheck must not do: its changes are left in place for a human";

	// A triage that edits fails as a recheck does, but the run goes on: its plan falls back to
	// every lens on a session of its own (`Review.decide`).
	const TRIAGE_EDITED =
		"the triage changed the working tree, which a triage must not do: its changes are left in place and every lens reviews in a session of its own";

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

	/** The actor on the answer the runner accepted, not a later duplicate inbox submission. */
	const answeredBy = (ctx: Ctx, questionId: string): string | undefined => {
		const entries = RunStore.questionEntries(ctx.deps.home, ctx.run.id);
		return entries.ok
			? entries.value.find(
					(entry) =>
						entry.context === `answers ${questionId}` && entry.by !== undefined,
				)?.by
			: undefined;
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
		home: ctx.deps.home,
		runId: ctx.run.id,
		record: ctx.deps.host.record,
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
		opened: (acpSessionId, ran) =>
			RunState.patchClaim(ctx, sessionId, {
				acpSessionId,
				...(ran.agent ? { agent: ran.agent } : {}),
				...(ran.model ? { model: ran.model } : {}),
				modelSource: ran.source,
				...(ran.tier ? { tier: ran.tier } : {}),
			}),
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

	// Open the loop session and, for a subtask it takes, mark it as taken; the session id, or
	// undefined.
	const open = async (
		ctx: Ctx,
		task: Task,
		harness: string,
		lane: string,
		takes: boolean,
	): Promise<string | undefined> => {
		const tag = { lane, task: label(task) };
		const sessionId = RunStore.newSessionId();
		if (takes) {
			const moved = await ctx.deps.host.record.edit({
				id: task.id,
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
				return undefined;
			}
		}
		const logged = await ctx.deps.host.record.log({
			id: task.id,
			refs: [
				{ uri: `loop:${ctx.run.id}`, label: "claim started" },
				{ uri: `session:${sessionId}`, label: `loop ${ctx.run.id}` },
			],
		});
		if (!logged.ok)
			RunState.event(ctx, {
				...tag,
				type: "warning",
				summary: `work log not written: ${logged.error.message}`,
			});
		return sessionId;
	};

	// `git <args>` where `claim` worked, the run's own tree without one: its output, or "".
	const git = (
		ctx: Ctx,
		args: string[],
		claim: Pick<RunStore.Claim, "worktree"> = {},
	): Promise<string> =>
		(ctx.deps.git ?? Worktree.git)(
			RunStore.claimDir(ctx.run, claim),
			args,
		).then((out) => (out.ok ? out.value.trim() : ""));

	// The worktree `claim` worked in, while its subtask still holds it.
	const heldBy = (
		ctx: Ctx,
		claim: RunStore.Claim,
	): ClaimTrees.Tree | undefined => {
		const tree = ClaimTrees.all(ctx.run).find(
			(t) => t.dir === claim.worktree && t.held?.taskId === claim.taskId,
		);
		return tree?.held ? { dir: tree.dir, branch: tree.held.branch } : undefined;
	};

	// Its task's work-log entries since it started, but for the loop's own record of its session.
	const loggedSince = async (
		ctx: Ctx,
		attempt: RunStore.Claim,
	): Promise<string[]> => {
		const logs = await ctx.deps.host.record.workLogs({ id: attempt.taskId });
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
			git(ctx, ["log", "--oneline", `--since=${previous.startedAt}`], previous),
			git(ctx, ["status", "--short"], previous),
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
		/** A subtask's own worktree, when it works in one (`ClaimTrees`). */
		worktree?: ClaimTrees.Tree;
		/** What its subtask's tags ask of it (`Route`): a subtask's fresh claim only. */
		route?: Pick<Route.Route, "tier" | "agent">;
		/** What the attempt whose session it resumes ran as, which it keeps (`continuing`). */
		kept?: Dispatch.Kept;
	};

	// A recheck or a triage reports and never edits; nothing enforces that in the harness, whose
	// settings are the user's, so a tree that changed under it fails it here instead, with `edited`
	// as its detail. Its edits stay where they are. Two rechecks running at once share the tree, so
	// one's edit fails both.
	const unedited = async (
		ctx: Ctx,
		tree: string,
		outcome: Dispatch.Outcome,
		edited: string,
	): Promise<Dispatch.Outcome> => {
		if (outcome.outcome !== "done" && outcome.outcome !== "incomplete")
			return outcome;
		return (await treeChanged(ctx, tree))
			? { ...outcome, outcome: "error", detail: edited }
			: outcome;
	};

	// The same directory goes to ACP and the brief, including a nested project's prefix.
	const briefTree = (
		run: RunStore.Run,
		claim: ClaimTrees.Tree | undefined,
	): Brief.Tree => ({
		worktree: run.worktree !== undefined,
		isolation: run.config.isolation,
		land: run.config.land,
		onLanded: run.config.onLanded,
		dir: claim ? RunStore.projectIn(run, claim.dir) : RunStore.sessionDir(run),
		branch: claim?.branch ?? RunStore.branchOf(run),
		runBranch: RunStore.branchOf(run),
	});

	// What a claim's session left once it ended: its outcome, failed when a session that must not edit
	// did, the gates a subtask it closed is owed, and the plan a triage answered.
	const afterSession = async (
		ctx: Ctx,
		{ task, harness, lane, sessionId, work, tree, worktree }: Started,
		ended: Dispatch.Outcome,
	): Promise<RunState.Settled> => {
		const outcome =
			tree === undefined
				? ended
				: await unedited(
						ctx,
						tree,
						ended,
						work.kind === "triage" ? TRIAGE_EDITED : EDITED,
					);
		const gates =
			work.kind === "implement" && outcome.outcome === "done"
				? await gatesAfter(
						ctx,
						{ taskId: task.id, label: label(task), lane, harness },
						worktree,
					)
				: undefined;
		const review =
			work.kind === "triage"
				? Review.decide(outcome, work.lenses, work.tiers)
				: undefined;
		return {
			taskId: task.id,
			sessionId,
			outcome,
			...(gates ? { gates } : {}),
			...(review ? { review } : {}),
		};
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
			worktree,
			route,
			kept,
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
					...(worktree ? { worktree: worktree.dir } : {}),
					...(work.kind === "lens"
						? { lenses: work.lenses.map((l) => l.name) }
						: {}),
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
							}
						: {}),
					...(work.kind === "triage" ? { triage: true as const } : {}),
					// A recheck's and a triage's: the tree it must leave as it found it.
					...(tree !== undefined ? { tree } : {}),
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
		const place = briefTree(ctx.run, worktree);
		// Every session, a lens's and the fixer's as much as an implementer's, launches through here.
		const overrides = LoopConfig.launchOverrides(
			ctx.run.config,
			harness,
			ctx.deps.overrides,
		);
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
				...(route?.tier ? { tier: route.tier } : {}),
				...(route?.agent ? { agent: route.agent } : {}),
				...(kept ? { kept } : {}),
			},
			{
				basePath: ctx.deps.basePath,
				host: ctx.deps.host,
				home: ctx.deps.home,
				kabaneBin: ctx.deps.kabaneBin,
				cwd: place.dir,
				runId: ctx.run.id,
				...(ctx.run.scopeUri ? { scopeUri: ctx.run.scopeUri } : {}),
				...(ctx.deps.mode ? { mode: ctx.deps.mode } : {}),
				...(overrides ? { overrides } : {}),
				models: ctx.run.config,
				tree: place,
			},
			hooks(ctx, sessionId, lane, label(task), harness),
		);
		const settled = handle.done.then(async (ended) => {
			ctx.settled.push(await afterSession(ctx, started, ended));
			ctx.wake();
		});
		ctx.live.set(sessionId, { taskId: task.id, handle, settled });
	};

	// The node's task as the tracker has it now, while the run may still claim it. The plan is a
	// snapshot: tracker changes are respected before acquiring it; this is not cross-process
	// compare-and-swap ownership.
	const claimable = async (
		ctx: Ctx,
		node: LoopPlan.Node,
		plan: LoopPlan.Plan,
	): Promise<Task | undefined> => {
		const current = await ctx.deps.host.record.get({ id: node.task.id });
		if (!current.ok) {
			RunState.event(ctx, {
				type: "warning",
				summary: `claim not read: ${current.error.message}`,
			});
			return undefined;
		}
		const task = current.value;
		return task &&
			LoopPlan.canClaim(task, ctx.now()) &&
			LoopPlan.isWorkOf(plan, task)
			? task
			: undefined;
	};

	// Where `task`'s claim works: in a worktree of its own for a subtask of a run whose claims are
	// isolated, in the run's tree otherwise (a single issue is the run's whole work). Undefined while
	// no worktree is free for it.
	const placeFor = async (
		ctx: Ctx,
		task: Task,
	): Promise<Result<{ worktree?: ClaimTrees.Tree } | undefined>> => {
		if (!RunStore.isolated(ctx.run) || task.id === ctx.run.parentId)
			return ok({});
		const tree = await ClaimTrees.acquire(ctx, task);
		if (!tree.ok) return tree;
		return ok(tree.value ? { worktree: tree.value } : undefined);
	};

	/**
	 * The attempt whose harness session a new claim on the same work resumes: an interrupted one
	 * that recorded its session, or the one a gate retry continues while that session has room.
	 * Undefined when the claim starts a fresh session.
	 */
	const continuing = (
		ctx: Ctx,
		previous: RunStore.Claim | undefined,
		retried: boolean,
	): (RunStore.Claim & { harness: Harnesses.Id }) | undefined => {
		if (!previous || !Harnesses.isId(previous.harness)) return undefined;
		const resumes =
			previous.outcome === "interrupted"
				? previous.acpSessionId !== undefined
				: retried &&
					Retry.session(previous, previous.harness, ctx.run.usage)?.resume ===
						true;
		return resumes ? { ...previous, harness: previous.harness } : undefined;
	};

	// How a claim reads on the trace: its harness, and the agent and tier it asks for or keeps.
	const routed = (
		harness: string,
		agent: string | undefined,
		tier: string | undefined,
	): string =>
		`${harness}${agent ? ` as ${agent}` : ""}${tier ? ` at tier ${tier}` : ""}`;

	type Routing = {
		harness: Harnesses.Id;
		/** How the claim reads on the trace: its harness, agent and tier. */
		as: string;
		/** What the dispatch is given: the tags' route for a fresh session, or what a resumed one keeps. */
		given: Pick<Started, "route" | "kept">;
		/** Why the tags do not route it as they say, one line each. */
		notes: string[];
	};

	/**
	 * Where a subtask's claim runs, and as what. The run's harness unless a `tier:<harness>/<name>`
	 * tag pins another, whatever the subtask's assignee says: agents assign issues they file to
	 * themselves, so the assignee names who wrote it, not who the human picked to work it. A resumed
	 * session goes on as it ran, on its harness, as its agent and on its model: the tags as they are
	 * now route a fresh session, and a session id never goes to another harness.
	 */
	const routing = (
		ctx: Ctx,
		task: Task,
		previous: RunStore.Claim | undefined,
		retried: boolean,
	): Routing => {
		const route = Route.of(task.tags, ctx.run.config);
		const tags = routed(route.harness, route.agent, route.tier);
		const resumed = continuing(ctx, previous, retried);
		if (!resumed)
			return {
				harness: route.harness,
				as: tags,
				given: { route },
				notes: route.notes,
			};
		const as = routed(resumed.harness, resumed.agent, resumed.tier);
		const differs =
			route.harness !== resumed.harness ||
			route.agent !== resumed.agent ||
			(route.tier !== undefined && route.tier !== resumed.tier);
		return {
			harness: resumed.harness,
			as,
			given: {
				kept: {
					...(resumed.agent ? { agent: resumed.agent } : {}),
					...(resumed.model ? { model: resumed.model } : {}),
					...(resumed.modelSource ? { source: resumed.modelSource } : {}),
					...(resumed.tier ? { tier: resumed.tier } : {}),
				},
			},
			notes: differs
				? [
						`${resumed.lane}'s session is resumed as it ran (${as}); the tags (${tags}) route a fresh session`,
					]
				: [],
		};
	};

	/**
	 * Claim one ready work node, a subtask or a single issue itself: a loop session, a dispatched
	 * ACP session, a live entry. False when it waits for a worktree of its own (`ClaimTrees`), an
	 * error when its worktree could not be readied (its setup failed), which stops the run; true
	 * otherwise, the node claimed or the tracker's changes having taken it out of the run's hands.
	 */
	export const claim = async (
		ctx: Ctx,
		node: LoopPlan.Node,
		plan: LoopPlan.Plan,
	): Promise<Result<boolean>> => {
		const task = await claimable(ctx, node, plan);
		if (task === undefined) return ok(true);
		const place = await placeFor(ctx, task);
		if (!place.ok) return place;
		if (place.value === undefined) return ok(false);
		const { worktree } = place.value;
		const earlier = ctx.run.claims.filter(
			(c) => c.taskId === task.id && !onParent(c),
		);
		const previous = earlier.at(-1);
		const retry = Gates.lastFailure(ctx.run.gateRuns, task.id);
		const routes = routing(ctx, task, previous, retry !== undefined);
		const { harness } = routes;
		const attempts = earlier.length;
		// Named by the subtask alone: its claim's trace says which harness, agent and model it ran on.
		const lane = `${label(task)}${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, task, harness, lane, true);
		if (sessionId === undefined) return ok(true);
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
				concurrent: worktree === undefined && RunStore.concurrency(ctx.run) > 1,
				...(retry ? { retry } : {}),
			},
			summary: `${routes.as} claims ${label(task)}: ${task.title}${worktree ? ` in ${worktree.dir}, on ${worktree.branch}` : ""}`,
			...routes.given,
			...(worktree ? { worktree } : {}),
			...(interrupted ? { interrupted } : {}),
			...(retryIn?.resume ? { resumes: retryIn } : {}),
		});
		// A tag the run could not honour, or one a resumed session leaves for a fresh one: the
		// claim runs on the fallback, and its lane says why.
		for (const note of routes.notes)
			RunState.event(ctx, {
				type: "warning",
				lane,
				session: sessionId,
				task: label(task),
				summary: note,
			});
		// Whether the harness resumes it is the dispatch's to say; why it was not tried is the run's.
		if (retryIn && !retryIn.resume)
			RunState.event(ctx, {
				type: "warning",
				lane,
				session: sessionId,
				task: label(task),
				summary: `${retryIn.lane}'s session not resumed${retry ? Retry.purpose(retry) : ""} (${retryIn.why}): a new session gets the full brief`,
			});
		return ok(true);
	};

	// Whether `claim` reviewed through exactly the group `names`, in any order: an earlier attempt at
	// the same review.
	const sameGroup = (
		claim: RunStore.Claim,
		names: readonly string[],
	): boolean =>
		claim.lenses !== undefined &&
		claim.lenses.length === names.length &&
		names.every((name) => claim.lenses?.includes(name));

	/**
	 * The latest pass, when it ran every gate green on the tree as it is now: what a review is told
	 * has checked the work, gate by gate, so it does not run those checks again.
	 */
	export const greenPass = async (
		ctx: Ctx,
	): Promise<readonly Gates.Result[] | undefined> => {
		const last = ctx.run.gateRuns.at(-1);
		if (
			last === undefined ||
			!Gates.configured(ctx.run.config.gates) ||
			!Gates.passed(ctx.run.config.gates, last.results)
		)
			return undefined;
		const tree = await ctx.tree(RunStore.sessionDir(ctx.run));
		return last.tree === tree ? last.results : undefined;
	};

	/**
	 * Run one review session on the parent through the group of lenses `names`, one or several, on
	 * the run's verifier harness, at `tier` when given (`Route`) and on the run's model otherwise.
	 * An error when a prompt cannot be read or the session cannot start.
	 */
	export const lens = async (
		ctx: Ctx,
		names: readonly string[],
		plan: LoopPlan.Plan,
		tier?: string,
	): Promise<Result<void>> => {
		const lenses: Brief.LensPrompt[] = [];
		for (const name of names) {
			const prompt = Lenses.prompt(RunStore.projectRoot(ctx.run), name);
			if (!prompt.ok) return prompt;
			lenses.push({ name, prompt: prompt.value.text });
		}
		const harness = ctx.run.config.verifier ?? ctx.run.config.implementer;
		const group = names.join("+");
		const earlier = ctx.run.claims.filter((c) => sameGroup(c, names));
		const attempts = earlier.length;
		const lane = `${group}-lens${attempts > 0 ? `#${attempts + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(
				new Error(
					`${Brief.lensNames(names)}${names.length === 1 ? "'s" : "'"} session did not start`,
				),
			);
		const interrupted = await interruption(ctx, earlier.at(-1));
		const passed = await greenPass(ctx);
		launch(ctx, plan, {
			...(interrupted ? { interrupted } : {}),
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: {
				kind: "lens",
				lenses,
				gates: Object.keys(ctx.run.config.gates),
				...(passed ? { passed } : {}),
			},
			...(tier ? { route: { tier } } : {}),
			summary: `${routed(harness, undefined, tier)} reviews ${label(plan.parent)} through ${Brief.lensNames(names)}`,
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
		const prompt = Lenses.prompt(RunStore.projectRoot(ctx.run), name);
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
		const passed = await greenPass(ctx);
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
				prompt: prompt.value.text,
				findings,
				base,
				diff: await git(ctx, ["diff", "--no-color", "--no-ext-diff", base]),
				gates: Object.keys(ctx.run.config.gates),
				...(passed ? { passed } : {}),
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
		tree: ClaimTrees.Tree | undefined,
	) => {
		if (
			!(Gates.configured(ctx.run.config.gates) || ctx.run.worktree) ||
			ctx.stopping.signal.aborted
		)
			return undefined;
		return Checks.gateWhen(
			ctx,
			async () => {
				const task = await ctx.deps.host.record.get({ id: subject.taskId });
				if (!task.ok || task.value?.state !== "done") return undefined;
				const reopened = await Checklists.refuseDone(
					ctx.deps.host,
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
			},
			tree,
		);
	};

	const observeStall = async (
		ctx: Ctx,
		taskId: string,
		claim: RunStore.Claim | undefined,
	): Promise<boolean> => {
		const plan = await LoopPlan.load(ctx.deps.host.record, ctx.run.parentId);
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

	// How a session's end reads on the trace: its outcome, unless its pass reopened `label`.
	const endedAs = (
		outcome: Dispatch.Outcome,
		reopened: string | undefined,
		label: string,
	): string =>
		reopened
			? `ended with ${label} open again: ${reopened}`
			: `${outcome.outcome}${outcome.detail ? `: ${outcome.detail}` : ""}`;

	/** Close the books on one ended session; true when the run has stalled. */
	export const settle = async (
		ctx: Ctx,
		{ taskId, sessionId, outcome, gates, review: decided }: RunState.Settled,
	): Promise<boolean> => {
		ctx.live.delete(sessionId);
		const claim = ctx.run.claims.find((c) => c.sessionId === sessionId);
		const review =
			claim?.lenses !== undefined ||
			claim?.recheck !== undefined ||
			claim?.triage === true;
		await closeSession(ctx, sessionId, outcome);
		if (claim && !onParent(claim)) await release(ctx, taskId, claim.harness);
		// Recorded while the claim is still open: a runner that dies before the record leaves an
		// open claim, and `recover` records the pass then.
		const reopened = gates
			? await Checks.record(ctx, gates, {
					taskId,
					label: claim?.shortId ?? taskId,
					assignee: claim?.harness,
					...(claim ? { lane: claim.lane } : {}),
				})
			: undefined;
		RunState.patchClaim(ctx, sessionId, {
			endedAt: ctx.now().toISOString(),
			outcome: outcome.outcome,
			...(outcome.detail ? { detail: outcome.detail } : {}),
		});
		const ended = ctx.run.claims.find((c) => c.sessionId === sessionId);
		// A session whose pass reopened its subtask did not leave it done, whatever its turn said:
		// the claim keeps its outcome, which a retry resumes on (`Retry`), and the trace says why.
		RunState.event(ctx, {
			type: "session_end",
			...(ended ? { lane: ended.lane, task: ended.shortId } : {}),
			session: sessionId,
			summary: endedAs(outcome, reopened, ended?.shortId ?? taskId),
		});
		if (decided) planReview(ctx, decided, ended?.lane);
		// A triage, a lens, and its recheck, runs once per run and files findings rather than closing work:
		// its end is not a step the stall detector should count.
		if (review) return false;
		return observeStall(ctx, taskId, claim);
	};

	// Whether a pass since `task` last changed gave a verdict on it: every gate it ran ran to an end.
	const judged = (ctx: Ctx, task: Task): boolean => {
		const last = ctx.run.gateRuns.findLast((r) => r.taskId === task.id);
		return (
			last !== undefined &&
			last.at >= task.updatedAt &&
			last.results.every((r) => r.exit !== null)
		);
	};

	/**
	 * The worktrees subtasks hold that no claim works in, once the tracker has settled their subtask
	 * some other way: one closed as done (by a human, or before a pass gave a verdict on it) has its
	 * pass run there, so its work merges or it is reopened; one cancelled or deleted lets go of its
	 * worktree, its branch kept.
	 */
	export const settleHeld = async (ctx: Ctx): Promise<void> => {
		for (const tree of ClaimTrees.all(ctx.run)) {
			const held = tree.held;
			if (
				held === undefined ||
				ctx.run.claims.some(
					(c) => c.endedAt === undefined && c.worktree === tree.dir,
				)
			)
				continue;
			const task = await ctx.deps.host.record.get({ id: held.taskId });
			if (!task.ok) continue;
			if (!task.value || task.value.state === "cancelled") {
				ClaimTrees.abandon(
					ctx,
					tree,
					`${task.value ? `${label(task.value)} was cancelled` : `${held.taskId} was deleted`} before its work merged`,
				);
				continue;
			}
			if (task.value.state !== "done" || judged(ctx, task.value)) continue;
			// The harness its last claim ran on, which its tags may have pinned.
			const target = {
				taskId: task.value.id,
				label: label(task.value),
				assignee:
					ctx.run.claims.findLast((c) => c.taskId === held.taskId)?.harness ??
					ctx.run.config.implementer,
			};
			const pass = await gatesAfter(
				ctx,
				{
					taskId: target.taskId,
					label: target.label,
					harness: target.assignee,
				},
				{ dir: tree.dir, branch: held.branch },
			);
			if (pass) await Checks.record(ctx, pass, target);
		}
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

	/**
	 * Store the run's review plan and put it on the trace: dropped names or tiers, as warnings, then
	 * one `review` event per group and per skipped lens.
	 */
	export const planReview = (
		ctx: Ctx,
		{ plan, notes }: Review.Decided,
		lane?: string,
	): void => {
		RunState.save(ctx, { ...ctx.run, review: plan });
		const tag = { ...(lane ? { lane } : {}), task: ctx.run.parentShortId };
		for (const note of notes)
			RunState.event(ctx, { ...tag, type: "warning", summary: note });
		for (const line of Review.lines(plan))
			RunState.event(ctx, { ...tag, type: "review", summary: line });
	};

	// What the run changed from `base`, as triage reads it, or which git read failed: unlike `git`,
	// a failure is not an empty diff.
	const triageDiff = async (
		ctx: Ctx,
		base: string,
	): Promise<Result<Review.Diff>> => {
		const reads = [
			["diff", "--stat", "--no-color", base],
			["diff", "--numstat", base],
			["ls-files", "--others", "--exclude-standard"],
		];
		const run = ctx.deps.git ?? Worktree.git;
		const dir = RunStore.sessionDir(ctx.run);
		const out = await Promise.all(reads.map((args) => run(dir, args)));
		const texts: string[] = [];
		for (const [i, read] of out.entries()) {
			if (!read.ok)
				return err(
					new Error(
						`\`git ${reads[i]?.join(" ")}\` failed: ${read.error.message}`,
					),
				);
			texts.push(read.value.trim());
		}
		const [stat = "", numstat = "", untracked = ""] = texts;
		return ok(
			Review.diff(
				base,
				stat,
				numstat,
				untracked.split("\n").filter((f) => f !== ""),
			),
		);
	};

	/**
	 * Triage the run's lenses (`Review`): one read-only session on the verifier harness, at
	 * `loop.review.tier`, reads the diff from `base` and each lens's frontmatter and answers the
	 * review plan, which its end stores. A new session each time: one a dead runner cut short runs
	 * again from the start. An error when a lens's prompt cannot be read or the session cannot start.
	 */
	export const triage = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
		base: string,
	): Promise<Result<void>> => {
		const lenses: Review.Lens[] = [];
		for (const name of ctx.run.config.lenses) {
			const prompt = Lenses.prompt(RunStore.projectRoot(ctx.run), name);
			if (!prompt.ok) return prompt;
			const { applies, always } = prompt.value;
			lenses.push({ name, always, ...(applies ? { applies } : {}) });
		}
		// Read before any session: a plan made on a diff git could not give would skip lenses
		// on no change information at all.
		const diff = await triageDiff(ctx, base);
		if (!diff.ok) return diff;
		const harness = ctx.run.config.verifier ?? ctx.run.config.implementer;
		const { tier } = ctx.run.config.review;
		const earlier = ctx.run.claims.filter((c) => c.triage === true);
		const lane = `${Review.LANE}${earlier.length > 0 ? `#${earlier.length + 1}` : ""}`;
		const sessionId = await open(ctx, plan.parent, harness, lane, false);
		if (sessionId === undefined)
			return err(new Error("the triage session did not start"));
		// From the first triage: what an interrupted one edited counts against the next.
		const tree =
			earlier[0]?.tree ?? (await ctx.tree(RunStore.sessionDir(ctx.run)));
		launch(ctx, plan, {
			tree,
			task: plan.parent,
			harness,
			lane,
			sessionId,
			work: {
				kind: "triage",
				lenses,
				diff: diff.value,
				tiers: LoopConfig.tierNames(ctx.run.config),
			},
			route: { tier },
			summary: `${routed(harness, undefined, tier)} triages the review of ${label(plan.parent)}: ${diff.value.files} ${diff.value.files === 1 ? "file" : "files"} and ${diff.value.lines} ${diff.value.lines === 1 ? "line" : "lines"} changed, through ${Brief.lensNames(lenses.map((l) => l.name))}`,
		});
		return ok(undefined);
	};
}
