// A pass over the run's gates and what follows from it: a checkpoint commit when it is green and
// the run has a worktree, naming the checklist items ticked since the last checkpoint of the same
// task, the pass in run.json and on the trace, and the result on the tracker. A subtask that works
// in a worktree of its own (`ClaimTrees`) has its checkpoint first, then the run's HEAD merged in,
// and its gates on that merge; a green pass fast-forwards the run's branch to it. A checkpoint
// refused there, or a merge that conflicts, fails the pass before any gate runs.
// A subtask's pass goes on its work log, and a red one reopens it; the run's own final pass goes
// on the parent's.
import { type Result } from "@kabane/core";
import { Checklists } from "./checklists";
import { Gates } from "./gates";
import { ok } from "./result";
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

	const gitOf = (ctx: Ctx): Worktree.Git => ctx.deps.git ?? Worktree.git;

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
		const items = await Checklists.of(ctx.deps.host, taskId);
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

	// A checkpoint's message: its first line, the checklist items it ticks, then `more`.
	const message = (
		first: string,
		items: readonly Checklists.Item[],
		more: readonly string[],
	): string =>
		[
			first,
			...(items.length > 0
				? [
						`Ticked:\n${items.map((item) => `- ${item.handle} ${item.text}`).join("\n")}`,
					]
				: []),
			...more,
		].join("\n\n");

	/** What a checkpoint's message says: `first` in place of the subject's, then `more`. */
	type Wording = { first?: string; more: readonly string[] };

	// The checkpoint `dir`'s pass commits, if any: an error when git (or a hook of the user's)
	// refused it, its changes left uncommitted where they are.
	const commit = async (
		ctx: Ctx,
		subject: Subject,
		dir: string | undefined,
		wording: Wording,
	): Promise<Result<Pick<Gates.Run, "checkpoint" | "ticked">>> => {
		if (dir === undefined) return ok({});
		const read = await snapshot(ctx, subject);
		const items = read?.named ?? [];
		const made = await Worktree.checkpoint(
			dir,
			message(
				wording.first ??
					`kabane loop ${ctx.run.id}: ${subject.label} ${subject.title}`,
				items,
				wording.more,
			),
			gitOf(ctx),
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
		// Nothing uncommitted is not nothing done: the session may have committed its work itself,
		// and the tree's HEAD is then that work.
		if (made.value === undefined) {
			const at = await gitOf(ctx)(dir, ["rev-parse", "--short=12", "HEAD"]);
			RunState.event(ctx, {
				...tag,
				type: "checkpoint",
				task: subject.label,
				summary: `no checkpoint for ${subject.label}: nothing left uncommitted${at.ok ? `, its tree stays at ${at.value.trim()}` : ""}`,
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
	 * subtask's own `tree`, the pass merges the run's HEAD in before its gates and lands by a
	 * fast-forward (`ClaimTrees`).
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
		return queued(ctx, body);
	};

	// One pass at a time. Two sessions ending together in the run's tree share a directory, and two
	// passes would run the gates over each other and race for git's index. A pass in a subtask's
	// own tree holds the run's HEAD still from its merge into that tree to the fast-forward onto
	// it, so what its gates ran on is what lands.
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
		const task = await ctx.deps.host.record.get({ id: subject.taskId });
		return task.ok && (!task.value || task.value.state === "cancelled");
	};

	// One pass in or out of `gating`, for the header: a pass under way shows as running, never as
	// the result of the one before it.
	const marking = (ctx: Ctx, label: string, running: boolean): void => {
		const now = ctx.run.gating ?? [];
		const at = now.indexOf(label);
		const next = running ? [...now, label] : now.filter((_, i) => i !== at);
		RunState.save(ctx, {
			...ctx.run,
			gating: next.length > 0 ? next : undefined,
		});
	};

	const gateNow = async (
		ctx: Ctx,
		subject: Subject,
		place: Place,
	): Promise<Gates.Run> => {
		marking(ctx, subject.label, true);
		try {
			return await passNow(ctx, subject, place);
		} finally {
			marking(ctx, subject.label, false);
		}
	};

	type Outcome = Pick<
		Gates.Run,
		"results" | "ok" | "checkpoint" | "ticked" | "merged"
	>;

	// The pass, in run.json.
	const save = async (
		ctx: Ctx,
		subject: Subject,
		{ dir, tree }: Place,
		outcome: Outcome,
	): Promise<Gates.Run> => {
		const pass: Gates.Run = {
			at: ctx.now().toISOString(),
			...(subject.taskId ? { taskId: subject.taskId } : {}),
			...outcome,
			tree: await ctx.tree(dir),
			...(tree ? { branch: tree.branch } : {}),
		};
		RunState.save(ctx, { ...ctx.run, gateRuns: [...ctx.run.gateRuns, pass] });
		return pass;
	};

	// The gates in `dir`, on the trace: `on` says what they run on, `none` what a pass with none does.
	const runGates = async (
		ctx: Ctx,
		subject: Subject,
		dir: string,
		{ on, none }: { on: string; none: string },
	): Promise<{ ran: Gates.Result[]; green: boolean }> => {
		const { gates } = ctx.run.config;
		const tag = subject.lane ? { lane: subject.lane } : {};
		RunState.event(ctx, {
			...tag,
			type: "gates",
			task: subject.label,
			summary: Gates.configured(gates)
				? `gates for ${subject.label}${on}: ${Object.keys(gates).join(", ")}`
				: `no gates configured for ${subject.label}${on}${none}`,
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
		return { ran, green };
	};

	const passNow = (
		ctx: Ctx,
		subject: Subject,
		place: Place,
	): Promise<Gates.Run> =>
		place.tree
			? treePass(ctx, subject, { ...place, tree: place.tree })
			: runPass(ctx, subject, place);

	// A pass in the run's own tree: the gates, then a green pass's checkpoint, whose refusal is a
	// warning and leaves the work uncommitted there.
	const runPass = async (
		ctx: Ctx,
		subject: Subject,
		place: Place,
	): Promise<Gates.Run> => {
		const { ran, green } = await runGates(ctx, subject, place.dir, {
			on: "",
			none: "; checkpointing it",
		});
		const committed = green
			? await commit(ctx, subject, place.worktree, {
					more: [
						ran.length > 0
							? `Gates passed: ${ran.map((r) => r.name).join(", ")}.`
							: "No gates configured.",
					],
				})
			: ok({});
		return save(ctx, subject, place, {
			results: ran,
			ok: green,
			...(committed.ok ? committed.value : {}),
		});
	};

	// A pass in a subtask's own tree (`ClaimTrees`): its session's work committed, the run's HEAD
	// merged in, the gates on that merge, and a green pass fast-forwarding the run's branch to it.
	// A checkpoint refused fails the pass, its work left uncommitted in the tree the subtask keeps;
	// a merge that conflicts fails it too, its conflicts left there mid-merge. Either way no gate
	// runs. A subtask cancelled or deleted while its gates ran does not land: its tree stays held,
	// for `Claims.settleHeld` to free with its branch kept.
	const treePass = async (
		ctx: Ctx,
		subject: Subject,
		place: Place & { tree: ClaimTrees.Tree },
	): Promise<Gates.Run> => {
		const { tree } = place;
		const into = RunStore.branchOf(ctx.run);
		const merging = `kabane loop ${ctx.run.id}: merge ${into} into ${tree.branch} for ${subject.label}`;
		const started = performance.now();
		// A merge its last pass left for its session to resolve: what this checkpoint concludes.
		const resolving =
			(await Worktree.mergeHead(tree.dir, gitOf(ctx))) === undefined
				? undefined
				: (Gates.lastFailure(
						ctx.run.gateRuns,
						subject.taskId ?? ctx.run.parentId,
					)?.conflicts ?? []);
		const committed = await commit(
			ctx,
			subject,
			tree.dir,
			resolving === undefined
				? { more: [] }
				: {
						first: merging,
						more:
							resolving.length > 0
								? [`Resolves the conflicts in ${resolving.join(", ")}.`]
								: [],
					},
		);
		if (!committed.ok)
			return save(ctx, subject, place, {
				results: [
					refused("checkpoint", "git commit", started, committed.error.message),
				],
				ok: false,
			});
		const kept = committed.value;
		const caught = await ClaimTrees.catchUp(ctx, tree, merging);
		if (!caught.ok || caught.value.length > 0)
			return save(ctx, subject, place, {
				results: [notCaughtUp(ctx, subject, tree, caught, started)],
				ok: false,
				...kept,
			});
		const { ran, green } = await runGates(ctx, subject, place.dir, {
			on: ` on ${tree.branch} with ${into} merged in`,
			none: "",
		});
		if (!green)
			return save(ctx, subject, place, { results: ran, ok: false, ...kept });
		return save(ctx, subject, place, {
			...(await landAfter(ctx, subject, tree, ran)),
			...kept,
		});
	};

	// The run's HEAD not merged into a subtask's `tree`, conflicting there or refused: the red
	// `merge` result its next brief quotes.
	const notCaughtUp = (
		ctx: Ctx,
		subject: Subject,
		tree: ClaimTrees.Tree,
		caught: Result<string[]>,
		started: number,
	): Gates.Result => {
		const into = RunStore.branchOf(ctx.run);
		const tail = caught.ok
			? `The run's branch ${into} has moved since ${subject.label} was cut, and merging it into ${tree.branch} left conflicts in ${caught.value.join(", ")}. The merge is in progress in this worktree, with the conflicts left for you: resolve them, keeping what both sides meant, then call kabane_done again. The runner commits the merge, then runs the gates on it.`
			: `The run's branch ${into} did not merge into ${tree.branch}: ${caught.error.message}`;
		RunState.event(ctx, {
			...(subject.lane ? { lane: subject.lane } : {}),
			type: caught.ok ? "merge_conflict" : "warning",
			task: subject.label,
			summary: caught.ok
				? `merging ${into} into ${tree.branch} left conflicts in ${caught.value.join(", ")}: no gate runs until ${subject.label} resolves them`
				: `${into} not merged into ${tree.branch}: ${caught.error.message}`,
		});
		return {
			...refused("merge", `git merge ${into}`, started, tail),
			...(caught.ok ? { conflicts: caught.value } : {}),
		};
	};

	// A green pass in a subtask's `tree`, landed on the run's branch by a fast-forward: what the
	// pass records. A subtask dropped while its gates ran does not land, and its pass stays green.
	const landAfter = async (
		ctx: Ctx,
		subject: Subject,
		tree: ClaimTrees.Tree,
		ran: Gates.Result[],
	): Promise<Pick<Gates.Run, "results" | "ok" | "merged">> => {
		const tag = subject.lane ? { lane: subject.lane } : {};
		if (await dropped(ctx, subject)) {
			RunState.event(ctx, {
				...tag,
				type: "warning",
				task: subject.label,
				summary: `${subject.label} not merged: it was cancelled or deleted while its pass ran`,
			});
			return { results: ran, ok: true };
		}
		const started = performance.now();
		const landed = await ClaimTrees.land(ctx, tree);
		RunState.event(ctx, {
			...tag,
			type: landed.ok ? "merged" : "warning",
			task: subject.label,
			summary: landed.ok
				? `${subject.label} merged into ${RunStore.branchOf(ctx.run)} at ${landed.value.slice(0, 12)}, a fast-forward to what its gates ran on`
				: landed.error.message,
			...(landed.ok ? { data: { sha: landed.value } } : {}),
		});
		return landed.ok
			? { results: ran, ok: true, merged: landed.value }
			: {
					results: [
						...ran,
						refused(
							"merge",
							`git merge --ff-only ${tree.branch}`,
							started,
							landed.error.message,
						),
					],
					ok: false,
				};
	};

	/** Why a red result reopens its subtask, as the trace says it: `merge conflict in a.ts`. */
	export const why = (failed: Gates.Result): string =>
		failed.conflicts
			? `merge conflict in ${failed.conflicts.join(", ")}`
			: Gates.describe(failed);

	/**
	 * Put a pass on the tracker: every gate's result (and the checkpoint) on `taskId`'s work log,
	 * the first failure's output as its note. A red gate on a subtask reopens it to `next`, so it
	 * is claimed again with that output in its brief; a gate the run's stop killed reopens nothing.
	 * Why it reopened the subtask, when it did.
	 */
	export const record = async (
		ctx: Ctx,
		pass: Gates.Run,
		target: { taskId: string; label: string; lane?: string; assignee?: string },
	): Promise<string | undefined> => {
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
			const logged = await ctx.deps.host.record.log({
				id: taskId,
				refs: [{ uri: `loop:${ctx.run.id}`, label: "gate results" }, ...refs],
				...(failed ? { note: failed.tail.slice(-NOTE_CHARS) } : {}),
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
			return undefined;
		// A human can park, cancel, retype or hand off the work while its gates run. A red
		// result only reopens the done issue owned by the claim that requested those gates.
		const current = await ctx.deps.host.record.get({ id: taskId });
		if (!current.ok) {
			RunState.event(ctx, {
				type: "warning",
				summary: `not read after a red gate: ${current.error.message}`,
			});
			return undefined;
		}
		if (
			current.value?.kind !== "issue" ||
			current.value.state !== "done" ||
			current.value.assignee !== target.assignee
		)
			return undefined;
		const reopened = await ctx.deps.host.record.edit({
			id: taskId,
			state: "next",
		});
		RunState.event(ctx, {
			...(target.lane ? { lane: target.lane } : {}),
			task: target.label,
			type: reopened.ok ? "reopened" : "warning",
			summary: reopened.ok
				? `${target.label} reopened: ${why(failed)}`
				: `not reopened after a red gate: ${reopened.error.message}`,
		});
		return reopened.ok ? why(failed) : undefined;
	};
}
