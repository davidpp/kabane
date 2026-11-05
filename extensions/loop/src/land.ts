// Landing a completed run's branch, as its `land` setting says: in the run's worktree, fetch the
// branch the run started from and rebase onto its latest commit, and gate the result again when
// the rebase moved anything. The user's own git does all of it, with their own credentials and
// config. The outcome is run.json's `landing`. A landing that fails leaves the run completed: the
// work is done and its gates were green, only getting it onto the base is left, and the branch
// stays as the run left it.
import { err, ok, type Result, type Task } from "@cabane/core";
import { Checks } from "./checks";
import { Gates } from "./gates";
import { RunState } from "./state";
import type { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Land {
	type Ctx = RunState.Ctx;

	type Outcome = Omit<RunStore.Landing, "at">;

	const short = (sha: string): string => sha.slice(0, 12);

	const notLanded = (why: string, extra: Partial<Outcome> = {}): Outcome => ({
		ok: false,
		summary: `Not landed: ${why}.`,
		...extra,
	});

	// The remote the base branch tracks, else origin.
	const remoteOf = async (
		git: Worktree.Git,
		dir: string,
		branch: string,
	): Promise<string> => {
		const configured = await git(dir, [
			"config",
			"--get",
			`branch.${branch}.remote`,
		]);
		const remote = configured.ok ? configured.value.trim() : "";
		return remote === "" ? "origin" : remote;
	};

	const revParse = async (
		git: Worktree.Git,
		dir: string,
		rev: string,
	): Promise<Result<string>> => {
		const parsed = await git(dir, ["rev-parse", "--verify", rev]);
		return parsed.ok ? ok(parsed.value.trim()) : parsed;
	};

	/** Where a landing stands once the branch is on the base's latest commit. */
	type OnBase = {
		dir: string;
		remote: string;
		base: string;
		rebased?: RunStore.Landing["rebased"];
		/** How the branch got onto the base, for the summary. */
		said: string;
	};

	/**
	 * Fetch the base and rebase the branch onto its latest commit, gating it again when that moved
	 * it. A conflict, or a red gate on the rebased branch, leaves the branch as the run left it.
	 */
	const onBase = async (
		ctx: Ctx,
		parent: Task,
	): Promise<Result<OnBase, Outcome>> => {
		const dir = ctx.run.worktree;
		if (dir === undefined)
			return err(notLanded("the run has no worktree, so no branch of its own"));
		const base = ctx.run.base?.branch;
		if (base === undefined)
			return err(
				notLanded(
					"the run started from a detached HEAD, so it has no branch to land onto",
				),
			);
		const git = ctx.deps.git ?? Worktree.git;
		const remote = await remoteOf(git, dir, base);
		const fetched = await git(dir, ["fetch", "-q", remote, base]);
		if (!fetched.ok) return err(notLanded(fetched.error.message));
		const onto = await revParse(git, dir, "FETCH_HEAD");
		if (!onto.ok) return err(notLanded(onto.error.message));
		const from = await revParse(git, dir, "HEAD");
		if (!from.ok) return err(notLanded(from.error.message));
		const target = `${remote}/${base} (${short(onto.value)})`;
		const contained = await git(dir, [
			"merge-base",
			"--is-ancestor",
			onto.value,
			from.value,
		]);
		if (contained.ok)
			return ok({ dir, remote, base, said: `The branch is on ${target}` });
		const rebased = await Worktree.rebase(dir, onto.value, git);
		if (!rebased.ok)
			return err(
				notLanded(
					`rebasing onto ${target}: ${rebased.error.message}; the branch is as the run left it`,
				),
			);
		const to = await revParse(git, dir, "HEAD");
		if (!to.ok) return err(notLanded(to.error.message));
		const moved = { from: from.value, to: to.value };
		const label = ctx.run.parentShortId;
		const pass = await Checks.gate(ctx, { label, title: parent.title });
		await Checks.record(ctx, pass, { taskId: ctx.run.parentId, label });
		const failed = pass.results.find((r) => !r.ok);
		if (failed === undefined)
			return ok({
				dir,
				remote,
				base,
				rebased: moved,
				said: `Rebased onto ${target}${Gates.configured(ctx.run.config.gates) ? ", gates green again" : ""}`,
			});
		const reset = await Worktree.reset(dir, from.value, git);
		return err(
			notLanded(
				`after rebasing onto ${target}, the gate ${Gates.describe(failed)}; ${reset.ok ? `the branch is back at ${short(from.value)}, as the run left it` : `the branch could not be put back at ${short(from.value)}: ${reset.error.message}`}`,
				{ rebased: moved },
			),
		);
	};

	/** Land the run's branch onto its base, and record what happened on the run and its trace. */
	export const land = async (
		ctx: Ctx,
		parent: Task,
	): Promise<RunStore.Landing> => {
		const placed = await onBase(ctx, parent);
		const outcome: Outcome = placed.ok
			? {
					ok: true,
					summary: `${placed.value.said}.`,
					...(placed.value.rebased ? { rebased: placed.value.rebased } : {}),
				}
			: placed.error;
		const landing: RunStore.Landing = {
			at: ctx.now().toISOString(),
			...outcome,
		};
		RunState.save(ctx, { ...ctx.run, landing });
		RunState.event(ctx, {
			type: landing.ok ? "landed" : "warning",
			summary: landing.summary,
		});
		return landing;
	};
}
