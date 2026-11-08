// A pass over the run's gates and what follows from it: a checkpoint commit when it is green and
// the run has a worktree, naming the checklist items ticked since the last checkpoint of the same
// task, the pass in run.json and on the trace, and the result on the tracker. A subtask that works
// in a worktree of its own (`ClaimTrees`) has its gates and checkpoint there, and a green pass then
// merges its branch into the run's; a checkpoint refused there, or a merge that conflicts, fails
// the pass as a red gate would.
// A subtask's pass goes on its work log, and a red one reopens it; the run's own final pass goes
// on the parent's.
import { ok, Planner, type Result } from "@cabane/core";
import { Checklists } from "./checklists";
import { Gates } from "./gates";
import { RunState } from "./state";
import { RunStore } from "./store";
import { ClaimTrees } from "./trees";
import { Worktree } from "./worktree";

export namespace Checks {
	type Ctx = RunState.Ctx;

	/** What a pass is for: a subtask, by id, or the run itself (no `taskId`). */
	export type Subject = {
		taskId?: string;
		/** Its short id, for the trace and the checkpoint's message. */
		label: string;
		title: string;
		lane?: string;
	};

	const NOTE_CHARS = 2_000;

	/** What a checkpoint read of its task's checklist: the items it names, and every one ticked. */
	type Snapshot = { named: Checklists.Item[]; ticked: string[] };

	/**
	 * The items of the pass's task (the run's own target for its final pass) that its last
	 * checkpoint in this run did not see ticked, or, with none, those ticked since the run started:
	 * what this checkpoint commits. The snapshot goes on the pass, in run.json, so an item ticked
	 * after this read is named next time, by this runner or one that resumes the run.
	 */
	const snapshot = async (
		ctx: Ctx,
		subject: Subject,
	): Promise<Snapshot | undefined> => {
		const taskId = subject.taskId ?? ctx.run.parentId;
		const items = await Checklists.of(ctx.deps.basePath, taskId);
		if (!items.ok) {
			RunState.event(ctx, {
				type: "warning",
				summary: `checklist of ${subject.label} not read: ${items.error.message}`,
			});
			return undefined;
		}
		const last = ctx.run.gateRuns.findLast(
			(r) =>
				r.checkpoint !== undefined && (r.taskId ?? ctx.run.parentId) === taskId,
		);
		return {
			named: Checklists.tickedSince(
				items.value,
				last?.ticked
					? { seen: last.ticked }
					: { at: last?.at ?? ctx.run.startedAt ?? ctx.run.createdAt },
			),
			ticked: items.value.filter((item) => item.done).map((item) => item.id),
		};
	};

	const message = (
		ctx: Ctx,
		subject: Subject,
		results: readonly Gates.Result[],
		items: readonly Checklists.Item[],
	): string =>
		[
			`kabane loop ${ctx.run.id}: ${subject.label} ${subject.title}`,
			...(items.length > 0
				? [
						`Ticked:\n${items.map((item) => `- ${item.handle} ${item.text}`).join("\n")}`,
					]
				: []),
			results.length > 0
				? `Gates passed: ${results.map((r) => r.name).join(", ")}.`
				: "No gates configured.",
		].join("\n\n");

	// The checkpoint a green pass commits, if any: an error when git (or a hook of the user's)
	// refused it, its changes left uncommitted where they are.
	const commit = async (
		ctx: Ctx,
		subject: Subject,
		results: readonly Gates.Result[],
		dir: string | undefined,
	): Promise<Result<Pick<Gates.Run, "checkpoint" | "ticked">>> => {
		if (dir === undefined) return ok({});
		const read = await snapshot(ctx, subject);
		const items = read?.named ?? [];
		const made = await Worktree.checkpoint(
			dir,
			message(ctx, subject, results, items),
			ctx.deps.git,
		);
		const tag = subject.lane ? { lane: subject.lane } : {};
		if (!made.ok) {
			RunState.event(ctx, {
				...tag,
				type: "warning",
				summary: `checkpoint not committed: ${made.error.message}`,
			});
			return made;
		}
		if (made.value === undefined) {
			RunState.event(ctx, {
				...tag,
				type: "checkpoint",
				summary: `no checkpoint for ${subject.label}: nothing changed since the last one`,
			});
			return ok({});
		}
		const handles = items.map((item) => item.handle).join(", ");
		RunState.event(ctx, {
			...tag,
			type: "checkpoint",
			task: subject.label,
			summary: `checkpoint ${made.value.slice(0, 12)} for ${subject.label}${handles ? `, ticking ${handles}` : ""}`,
			data: { sha: made.value, ...(handles ? { ticked: handles } : {}) },
		});
		return ok({
			checkpoint: made.value,
			...(read ? { ticked: read.ticked } : {}),
		});
	};

	/** Where a pass runs: the gates in `dir`, a checkpoint in `worktree`, and a subtask's `tree`. */
	type Place = { dir: string; worktree?: string; tree?: ClaimTrees.Tree };

	const runPlace = (run: RunStore.Run): Place => ({
		dir: RunStore.sessionDir(run),
		...(run.worktree ? { worktree: run.worktree } : {}),
	});

	/**
	 * Run the gates for `subject` in the run's own tree, commit a checkpoint when they pass in a run
	 * with a worktree, and record the pass. A run that stops meanwhile kills the gate.
	 */
	export const gate = (ctx: Ctx, subject: Subject): Promise<Gates.Run> =>
		queued(ctx, () => gateNow(ctx, subject, runPlace(ctx.run)));

	/**
	 * `gate`, for a subject `ready` settles once the pass's turn comes rather than when it queues:
	 * the tracker may change while it waits behind another pass. Undefined, it runs nothing. In a
	 * subtask's own `tree` the pass waits for no other: only its merge into the run's branch does.
	 */
	export const gateWhen = (
		ctx: Ctx,
		ready: () => Promise<Subject | undefined>,
		tree?: ClaimTrees.Tree,
	): Promise<Gates.Run | undefined> => {
		const body = async () => {
			const subject = await ready();
			if (subject === undefined) return undefined;
			return gateNow(
				ctx,
				subject,
				tree
					? {
							dir: RunStore.projectIn(ctx.run, tree.dir),
							worktree: tree.dir,
							tree,
						}
					: runPlace(ctx.run),
			);
		};
		return tree ? body() : queued(ctx, body);
	};

	// One pass at a time in the run's tree, and one merge into it: two sessions ending together
	// there share a directory, and two passes would run the gates over each other and race for
	// git's index.
	const queued = <T>(ctx: Ctx, body: () => Promise<T>): Promise<T> => {
		const pass = ctx.gating.then(body);
		ctx.gating = pass.catch(() => undefined);
		return pass;
	};

	// A step after the gates that failed the pass as a red gate would: its output is what the
	// subtask's next brief quotes.
	const refused = (
		name: string,
		command: string,
		started: number,
		tail: string,
	): Gates.Result => ({
		name,
		command,
		ok: false,
		exit: 1,
		ms: Math.round(performance.now() - started),
		tail,
	});

	// Whether the subtask a pass is for was cancelled or deleted since its turn came: a human can
	// do either while its gates run or its merge waits behind another. Unread, it counts as not.
	const dropped = async (ctx: Ctx, subject: Subject): Promise<boolean> => {
		if (subject.taskId === undefined) return false;
		const task = await Planner.getTask(ctx.deps.basePath, subject.taskId);
		return task.ok && (!task.value || task.value.state === "cancelled");
	};

	// A green pass in a subtask's tree, merged into the run's branch: the commit that left it at, or
	// the merge's failure as a red result for the subtask's next brief. Undefined when the subtask
	// was dropped before its merge's turn came: its tree stays held, for `Claims.settleHeld` to free
	// with its branch kept, as it frees any a cancelled or deleted subtask holds.
	const mergeIn = async (
		ctx: Ctx,
		subject: Subject,
		tree: ClaimTrees.Tree,
	): Promise<{ merged: string } | { failed: Gates.Result } | undefined> => {
		const started = performance.now();
		const merged = await queued(ctx, async () =>
			(await dropped(ctx, subject))
				? undefined
				: ClaimTrees.merge(ctx, tree, {
						id: subject.taskId ?? ctx.run.parentId,
						shortId: subject.label,
						title: subject.title,
					}),
		);
		const tag = subject.lane ? { lane: subject.lane } : {};
		if (merged === undefined) {
			RunState.event(ctx, {
				...tag,
				type: "warning",
				task: subject.label,
				summary: `${subject.label} not merged: it was cancelled or deleted while its pass ran`,
			});
			return undefined;
		}
		RunState.event(ctx, {
			...tag,
			type: merged.ok ? "merged" : "merge_conflict",
			task: subject.label,
			summary: merged.ok
				? `${subject.label} merged into ${RunStore.branchOf(ctx.run)} at ${merged.value.slice(0, 12)}`
				: merged.error.message,
			...(merged.ok ? { data: { sha: merged.value } } : {}),
		});
		if (merged.ok) return { merged: merged.value };
		return {
			failed: refused(
				"merge",
				`git merge --no-ff ${tree.branch}`,
				started,
				merged.error.message,
			),
		};
	};

	const gateNow = async (
		ctx: Ctx,
		subject: Subject,
		place: Place,
	): Promise<Gates.Run> => {
		const { dir, tree } = place;
		const { gates } = ctx.run.config;
		const tag = subject.lane ? { lane: subject.lane } : {};
		RunState.event(ctx, {
			...tag,
			type: "gates",
			task: subject.label,
			summary: Gates.configured(gates)
				? `gates for ${subject.label}: ${Object.keys(gates).join(", ")}`
				: `no gates configured for ${subject.label}; checkpointing it`,
		});
		const ran = await Gates.run(
			gates,
			dir,
			{ KABANE_LOOP: "1", KABANE_LOOP_RUN: ctx.run.id },
			ctx.stopping.signal,
		);
		const green = Gates.passed(gates, ran);
		RunState.event(ctx, {
			...tag,
			type: green ? "gate_passed" : "gate_failed",
			task: subject.label,
			summary: ran.map(Gates.describe).join(" · ") || "no gate ran",
		});
		const started = performance.now();
		const committed = green
			? await commit(ctx, subject, ran, place.worktree)
			: ok({});
		// In a subtask's own tree, a checkpoint refused fails the pass: its work is not on its
		// branch, so nothing of it would merge, and freeing the tree would throw it away. The
		// subtask keeps the tree, its work uncommitted there, for its next claim.
		const merge =
			!green || !tree
				? undefined
				: committed.ok
					? await mergeIn(ctx, subject, tree)
					: {
							failed: refused(
								"checkpoint",
								"git commit",
								started,
								committed.error.message,
							),
						};
		const results = merge && "failed" in merge ? [...ran, merge.failed] : ran;
		const pass: Gates.Run = {
			at: ctx.now().toISOString(),
			...(subject.taskId ? { taskId: subject.taskId } : {}),
			results,
			ok: green && !(merge && "failed" in merge),
			tree: await ctx.tree(dir),
			...(committed.ok ? committed.value : {}),
			...(tree ? { branch: tree.branch } : {}),
			...(merge && "merged" in merge ? { merged: merge.merged } : {}),
		};
		RunState.save(ctx, { ...ctx.run, gateRuns: [...ctx.run.gateRuns, pass] });
		return pass;
	};

	/**
	 * Put a pass on the tracker: every gate's result (and the checkpoint) on `taskId`'s work log,
	 * the first failure's output as its note. A red gate on a subtask reopens it to `next`, so it
	 * is claimed again with that output in its brief; a gate the run's stop killed reopens nothing.
	 */
	export const record = async (
		ctx: Ctx,
		pass: Gates.Run,
		target: { taskId: string; label: string; lane?: string; assignee?: string },
	): Promise<void> => {
		const { taskId } = target;
		const failed = pass.results.find((r) => !r.ok);
		const refs = [
			...pass.results.map((r) => ({
				uri: `gate:${r.name}`,
				label: Gates.describe(r),
			})),
			...(pass.checkpoint
				? [{ uri: `commit:${pass.checkpoint}`, label: "loop checkpoint" }]
				: []),
			...(pass.merged
				? [
						{
							uri: `commit:${pass.merged}`,
							label: `merged into ${RunStore.branchOf(ctx.run)}`,
						},
					]
				: []),
		];
		if (refs.length > 0) {
			const logged = await Planner.addWorkLog(ctx.deps.basePath, {
				taskId,
				refs,
				...(failed ? { note: failed.tail.slice(-NOTE_CHARS) } : {}),
				addedBy: `loop:${ctx.run.id}`,
				addedByType: "ai",
			});
			if (!logged.ok)
				RunState.event(ctx, {
					type: "warning",
					summary: `gate results not logged: ${logged.error.message}`,
				});
		}
		// Only a gate that ran to a red exit reopens: one the stop killed, or never reached, gave
		// no verdict, and the subtask keeps the state its session left it in.
		if (
			pass.taskId === undefined ||
			failed === undefined ||
			failed.exit === null
		)
			return;
		// A human can park, cancel, retype or hand off the work while its gates run. A red
		// result only reopens the done issue owned by the claim that requested those gates.
		const current = await Planner.getTask(ctx.deps.basePath, taskId);
		if (!current.ok) {
			RunState.event(ctx, {
				type: "warning",
				summary: `not read after a red gate: ${current.error.message}`,
			});
			return;
		}
		if (
			current.value?.kind !== "issue" ||
			current.value.state !== "done" ||
			current.value.assignee !== target.assignee
		)
			return;
		const reopened = await Planner.updateTask(ctx.deps.basePath, taskId, {
			state: "next",
		});
		RunState.event(ctx, {
			...(target.lane ? { lane: target.lane } : {}),
			task: target.label,
			type: reopened.ok ? "reopened" : "warning",
			summary: reopened.ok
				? `${target.label} reopened: ${Gates.describe(failed)}`
				: `not reopened after a red gate: ${reopened.error.message}`,
		});
	};
}
