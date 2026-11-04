// The run's parent in the tracker. A run that starts or resumes takes the parent into
// in_progress, and nothing in the run takes it out: merging the run's work is the human's step,
// so a completed run flags the parent for review and the human closes it. Every end of a run is
// a comment on the parent saying how it ended and what to do next. A state a human gave the
// parent during the run is theirs: the end of the run only comments on it.
//
// A single-issue run's target is its own work node, so its state is the claim's: taking it here
// would leave nothing to claim. Its session closes it, and the completed run flags it for review
// while its work waits to be merged.
import { authorTypeOf, Planner, Runtime, type Task } from "@cabane/core";
import { LoopPlan } from "./plan";
import { RunState } from "./state";
import type { RunStore } from "./store";
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
	 * Move the parent to in_progress, logging the run on it, when it is not there already and is
	 * not the single issue the run claims.
	 */
	export const take = async (ctx: Ctx, resumed: boolean): Promise<void> => {
		const plan = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		if (!plan.ok) {
			warn(ctx, `parent not read: ${plan.error.message}`);
			return;
		}
		const { parent } = plan.value;
		if (LoopPlan.single(plan.value) || !TAKEN_FROM.includes(parent.state))
			return;
		const moved = await Planner.updateTask(ctx.deps.basePath, parent.id, {
			state: "in_progress",
		});
		if (!moved.ok) {
			warn(ctx, `parent not moved to in_progress: ${moved.error.message}`);
			return;
		}
		const logged = await Planner.addWorkLog(ctx.deps.basePath, {
			taskId: parent.id,
			refs: [
				{
					uri: `loop:${ctx.run.id}`,
					label: `loop run ${resumed ? "resumed" : "started"}`,
				},
			],
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

	const completed = async (
		ctx: Ctx,
		exit: Exit,
		plan: LoopPlan.Plan | undefined,
	): Promise<string> => {
		const head = `Loop run ${ctx.run.id} completed (${exit.reason}).`;
		if (!plan) return `${head}\n\n${await where(ctx, false)}`;
		const single = LoopPlan.single(plan);
		const work = plan.nodes.filter(LoopPlan.isWork).map((n) => n.task);
		const found = plan.nodes.filter((n) => n.finding).map((n) => n.task);
		const done = (t: Task) => t.state === "done";
		return [
			head,
			"",
			...(single
				? []
				: [`- Subtasks done: ${work.filter(done).length} of ${work.length}`]),
			`- Findings fixed: ${list(found.filter(done))}`,
			`- Findings left open for you: ${list(found.filter((t) => !LoopPlan.isClosed(t)))}`,
			"",
			await where(ctx, single),
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

	const stopped = (ctx: Ctx, exit: Exit, single: boolean): string =>
		[
			`Loop run ${ctx.run.id} ${exit.status}: ${exit.reason}${exit.detail ? ` (${exit.detail})` : ""}.`,
			"",
			`Next: ${nextStep(ctx.run, exit.reason, single)}`,
		].join("\n");

	// A single issue its session closed is flagged as a parent left in progress is: its work is
	// done, and still waits on the human's merge.
	const flaggable = (parent: Task, single: boolean): boolean =>
		parent.state === "in_progress" || (single && parent.state === "done");

	/**
	 * Comment the run's end on the parent. A completed run whose parent is still in_progress (or,
	 * for a single issue, done by its session) also flags it for review; one a human moved during
	 * the run keeps the state they gave it.
	 */
	export const report = async (ctx: Ctx, exit: Exit): Promise<void> => {
		const loaded = await LoopPlan.load(ctx.deps.basePath, ctx.run.parentId);
		const plan = loaded.ok ? loaded.value : undefined;
		const single = plan !== undefined && LoopPlan.single(plan);
		const body =
			exit.status === "completed"
				? await completed(ctx, exit, plan)
				: stopped(ctx, exit, single);
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
		if (!parent || !flaggable(parent, single)) return;
		const flagged = await Planner.updateTask(ctx.deps.basePath, parent.id, {
			needsReview: true,
		});
		if (!flagged.ok)
			warn(ctx, `parent not flagged for review: ${flagged.error.message}`);
	};
}
