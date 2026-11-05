// The run's parent in the tracker. A run that starts or resumes takes the parent into
// in_progress, and nothing in the run takes it out: merging the run's work is the human's step,
// so a completed run flags the parent for review and the human closes it. A run whose landing
// opened a pull request also moves it to waiting, on that review, and records the pull request as
// its upstream twin; a later run on the parent takes it from waiting again. Every end of a run is
// a comment on the parent saying how it ended and what to do next. A state a human gave the
// parent during the run is theirs: the end of the run only comments on it.
//
// A single-issue run's target is its own work node, so its state is the claim's: taking it here
// would leave nothing to claim. Its session closes it, and the completed run flags it for review
// while its work waits to be merged. One a human gives a work child during the run is a parent
// from then on: once its own session has ended, the run takes it as it takes any parent, and the
// end of the run says it changed shape.
import { authorTypeOf, Planner, Runtime, type Task } from "@cabane/core";
import { LoopPlan } from "./plan";
import { RunState } from "./state";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Parent {
	type Ctx = RunState.Ctx;
	type Exit = { status: RunStore.Status; reason: string; detail?: string };

	// The states a run takes the parent from. A done parent a run is started on has open findings
	// a human chose to run the fixer on; someday and cancelled stay parked.
	const TAKEN_FROM: readonly Task["state"][] = [
		"inbox",
		"next",
		"waiting",
		"done",
	];

	const warn = (ctx: Ctx, summary: string): void =>
		RunState.event(ctx, { type: "warning", summary });

	const read = async (ctx: Ctx): Promise<Task | undefined> => {
		const parent = await Planner.getTask(ctx.deps.basePath, ctx.run.parentId);
		if (!parent.ok) {
			warn(ctx, `parent not read: ${parent.error.message}`);
			return undefined;
		}
		return parent.value ?? undefined;
	};

	/**
	 * Move the parent to in_progress from one of `from`, logging `why` on it, unless it is the
	 * single issue the run claims.
	 */
	export const take = async (
		ctx: Ctx,
		why: string,
		from: readonly Task["state"][] = TAKEN_FROM,
	): Promise<void> => {
		const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		if (!plan.ok) {
			warn(ctx, `parent not read: ${plan.error.message}`);
			return;
		}
		const { parent } = plan.value;
		if (LoopPlan.single(plan.value) || !from.includes(parent.state)) return;
		const moved = await Planner.updateTask(ctx.deps.basePath, parent.id, {
			state: "in_progress",
		});
		if (!moved.ok) {
			warn(ctx, `parent not moved to in_progress: ${moved.error.message}`);
			return;
		}
		const logged = await Planner.addWorkLog(ctx.deps.basePath, {
			taskId: parent.id,
			refs: [{ uri: `loop:${ctx.run.id}`, label: why }],
			note: `${parent.state} → in_progress`,
			addedBy: `loop:${ctx.run.id}`,
			addedByType: "ai",
		});
		if (!logged.ok)
			warn(ctx, `parent work log not written: ${logged.error.message}`);
	};

	const label = (task: Task): string => task.shortId ?? task.id;

	const list = (tasks: readonly Task[]): string =>
		tasks.length === 0 ? "none" : tasks.map(label).join(", ");

	// What the end of the run says when it started on a single issue that is a parent now.
	const reshaped = (ctx: Ctx, plan: LoopPlan.Plan): string[] => {
		if (LoopPlan.single(plan) || RunStore.onTarget(ctx.run).length === 0)
			return [];
		const short = ctx.run.parentShortId;
		const work = plan.nodes.filter(LoopPlan.isWork).map((n) => n.task);
		return [
			"",
			`${short} was a single issue when the run started. Subtasks were added under it during the run (${list(work)}), so from then on the run treated it as their parent, and they waited for every session on ${short} itself to end.`,
		];
	};

	// Where the run's work is: the worktree's branch, which git names (a run may work on a branch
	// it did not create), or the project checkout itself. A single issue its session closed has
	// nothing left to close.
	const where = async (ctx: Ctx, single: boolean): Promise<string> => {
		const { worktree, projectDir } = ctx.run;
		if (worktree === undefined)
			return `The changes are in the working tree of \`${projectDir}\`.`;
		const branch = await (ctx.deps.git ?? Worktree.git)(worktree, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		const name = branch.ok ? branch.value.trim() : "";
		const merge = `Merge ${name ? `branch \`${name}\`` : "the branch"} from the worktree \`${worktree}\``;
		return single
			? `${merge}.`
			: `${merge}, then close ${ctx.run.parentShortId}.`;
	};

	// Where the work went: the pull request a landing opened, else the branch to merge by hand, with
	// why the landing did not get it there when one was tried.
	const landed = async (ctx: Ctx, single: boolean): Promise<string> => {
		const { landing, pr } = ctx.run;
		if (landing?.ok && pr)
			return `${landing.summary} ${ctx.run.parentShortId} waits on its review.`;
		const merge = await where(ctx, single);
		return landing ? `${landing.summary}\n\n${merge}` : merge;
	};

	const completed = async (
		ctx: Ctx,
		exit: Exit,
		plan: LoopPlan.Plan | undefined,
	): Promise<string> => {
		const head = `Loop run ${ctx.run.id} completed (${exit.reason}).`;
		if (!plan) return `${head}\n\n${await landed(ctx, false)}`;
		const single = LoopPlan.single(plan);
		const work = plan.nodes.filter(LoopPlan.isWork).map((n) => n.task);
		const found = plan.nodes.filter((n) => n.finding).map((n) => n.task);
		const done = (t: Task) => t.state === "done";
		return [
			head,
			...reshaped(ctx, plan),
			"",
			...(single
				? []
				: [`- Subtasks done: ${work.filter(done).length} of ${work.length}`]),
			`- Findings fixed: ${list(found.filter(done))}`,
			`- Findings left open for you: ${list(found.filter((t) => !LoopPlan.isClosed(t)))}`,
			"",
			await landed(ctx, single),
		].join("\n");
	};

	// A stopped run cannot be resumed (only a run whose runner died is), so going on means a new
	// run on the parent.
	const nextStep = (
		run: RunStore.Run,
		reason: string,
		single: boolean,
	): string => {
		const start = `\`kabane loop start ${run.parentShortId}\``;
		const status = `\`kabane loop status ${run.id}\``;
		if (reason === "stop-requested") return `${start} starts a new run.`;
		if (reason.startsWith("budget:"))
			return `${start} with a larger budget starts a new run.`;
		if (reason === "deadlocked")
			return `Break the blocking cycle between the subtasks, then ${start}.`;
		if (reason === "gates-red")
			return `Fix what the gate reports (or reopen ${single ? run.parentShortId : "the subtask it belongs to"}), then ${start}.`;
		return `${status} shows the run's trace; ${start} starts a new run once the cause is fixed.`;
	};

	const stopped = (
		ctx: Ctx,
		exit: Exit,
		plan: LoopPlan.Plan | undefined,
	): string =>
		[
			`Loop run ${ctx.run.id} ${exit.status}: ${exit.reason}${exit.detail ? ` (${exit.detail})` : ""}.`,
			...(plan ? reshaped(ctx, plan) : []),
			"",
			`Next: ${nextStep(ctx.run, exit.reason, plan !== undefined && LoopPlan.single(plan))}`,
		].join("\n");

	// A single issue its session closed is flagged as a parent left in progress is: its work is
	// done, and still waits on the human's merge.
	const flaggable = (parent: Task, single: boolean): boolean =>
		parent.state === "in_progress" || (single && parent.state === "done");

	// `https://github.com/<owner>/<repo>/pull/<n>`, as `<owner>/<repo>#<n>`.
	const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

	/** Record the run's pull request as the parent's upstream twin. */
	const twin = async (ctx: Ctx, parent: Task): Promise<void> => {
		const { pr } = ctx.run;
		if (!ctx.run.landing?.ok || pr === undefined) return;
		const path = URL.canParse(pr) ? PR_PATH.exec(new URL(pr).pathname) : null;
		const linked = await Planner.upsertUpstreamLink(ctx.deps.basePath, {
			taskId: parent.id,
			provider: "github",
			externalId: pr,
			...(path ? { identifier: `${path[1]}/${path[2]}#${path[3]}` } : {}),
			url: pr,
			title: parent.title,
		});
		if (!linked.ok)
			warn(ctx, `pull request not linked: ${linked.error.message}`);
	};

	/**
	 * Comment the run's end on the parent. A completed run whose parent is still in_progress (or,
	 * for a single issue, done by its session) also flags it for review, and moves it to waiting
	 * when its landing opened a pull request; one a human moved during the run keeps the state they
	 * gave it. A pull request is the parent's upstream twin either way.
	 */
	export const report = async (ctx: Ctx, exit: Exit): Promise<void> => {
		const loaded = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		const plan = loaded.ok ? loaded.value : undefined;
		const single = plan !== undefined && LoopPlan.single(plan);
		const body =
			exit.status === "completed"
				? await completed(ctx, exit, plan)
				: stopped(ctx, exit, plan);
		const actor = Runtime.actor();
		const commented = await Planner.addComment(ctx.deps.basePath, {
			taskId: ctx.run.parentId,
			author: actor,
			authorType: authorTypeOf(actor),
			content: body,
		});
		if (!commented.ok)
			warn(ctx, `parent not commented: ${commented.error.message}`);
		if (exit.status !== "completed") return;
		const parent = await read(ctx);
		if (!parent) return;
		await twin(ctx, parent);
		if (!flaggable(parent, single)) return;
		const flagged = await Planner.updateTask(ctx.deps.basePath, parent.id, {
			needsReview: true,
			...(ctx.run.landing?.ok && ctx.run.pr ? { state: "waiting" } : {}),
		});
		if (!flagged.ok)
			warn(ctx, `parent not flagged for review: ${flagged.error.message}`);
	};
}
