// A pass over the run's gates and what follows from it: a checkpoint commit when it is green and
// the run has a worktree, the pass in run.json and on the trace, and the result on the tracker.
// A subtask's pass goes on its work log, and a red one reopens it; the run's own final pass goes
// on the parent's.
import { Planner } from "@cabane/core";
import { Gates } from "./gates";
import { RunState } from "./state";
import { RunStore } from "./store";
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

	const commit = (
		ctx: Ctx,
		subject: Subject,
		results: readonly Gates.Result[],
	): string | undefined => {
		const dir = ctx.run.worktree;
		if (dir === undefined) return undefined;
		const message = `kabane loop ${ctx.run.id}: ${subject.label} ${subject.title}\n\nGates passed: ${results.map((r) => r.name).join(", ")}.`;
		const made = Worktree.checkpoint(dir, message, ctx.deps.git);
		const tag = subject.lane ? { lane: subject.lane } : {};
		if (!made.ok) {
			RunState.event(ctx, {
				...tag,
				type: "warning",
				summary: `checkpoint not committed: ${made.error.message}`,
			});
			return undefined;
		}
		if (made.value === undefined) {
			RunState.event(ctx, {
				...tag,
				type: "checkpoint",
				summary: `no checkpoint for ${subject.label}: nothing changed since the last one`,
			});
			return undefined;
		}
		RunState.event(ctx, {
			...tag,
			type: "checkpoint",
			task: subject.label,
			summary: `checkpoint ${made.value.slice(0, 12)} for ${subject.label}`,
			data: { sha: made.value },
		});
		return made.value;
	};

	/**
	 * Run the gates for `subject` in the sessions' directory, commit a checkpoint when they pass in
	 * a run with a worktree, and record the pass. A run that stops meanwhile kills the gate.
	 */
	export const gate = async (
		ctx: Ctx,
		subject: Subject,
	): Promise<Gates.Run> => {
		const dir = RunStore.sessionDir(ctx.run);
		const { gates } = ctx.run.config;
		const tag = subject.lane ? { lane: subject.lane } : {};
		RunState.event(ctx, {
			...tag,
			type: "gates",
			task: subject.label,
			summary: `gates for ${subject.label}: ${Object.keys(gates).join(", ")}`,
		});
		const results = await Gates.run(
			gates,
			dir,
			{ KABANE_LOOP: "1", KABANE_LOOP_RUN: ctx.run.id },
			ctx.stopping.signal,
		);
		const ok = Gates.passed(gates, results);
		RunState.event(ctx, {
			...tag,
			type: ok ? "gate_passed" : "gate_failed",
			task: subject.label,
			summary: results.map(Gates.describe).join(" · ") || "no gate ran",
		});
		const checkpoint = ok ? commit(ctx, subject, results) : undefined;
		const pass: Gates.Run = {
			at: ctx.now().toISOString(),
			...(subject.taskId ? { taskId: subject.taskId } : {}),
			results,
			ok,
			tree: ctx.tree(dir),
			...(checkpoint ? { checkpoint } : {}),
		};
		RunState.save(ctx, { ...ctx.run, gateRuns: [...ctx.run.gateRuns, pass] });
		return pass;
	};

	/**
	 * Put a pass on the tracker: every gate's result (and the checkpoint) on `taskId`'s work log,
	 * the first failure's output as its note. A red pass on a subtask reopens it to `next`, so it
	 * is claimed again with that output in its brief.
	 */
	export const record = async (
		ctx: Ctx,
		pass: Gates.Run,
		target: { taskId: string; label: string; lane?: string },
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
		if (pass.ok || pass.taskId === undefined) return;
		const reopened = await Planner.updateTask(ctx.deps.basePath, taskId, {
			state: "next",
		});
		RunState.event(ctx, {
			...(target.lane ? { lane: target.lane } : {}),
			task: target.label,
			type: reopened.ok ? "reopened" : "warning",
			summary: reopened.ok
				? `${target.label} reopened: ${failed ? Gates.describe(failed) : "a gate did not run"}`
				: `not reopened after a red gate: ${reopened.error.message}`,
		});
	};
}
