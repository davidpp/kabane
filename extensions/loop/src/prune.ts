// When a run's worktree is done with. One whose run has a pull request is done once GitHub says it
// is merged: a squash or rebase merge leaves the branch's own commits out of the base, so git would
// call the branch unmerged forever. Without a pull request, or when gh cannot say, git decides: the
// branch is merged once its tip is in the project's HEAD. A pull request still open keeps the
// worktree for the parent's next run, which pushes review fixes to it; one closed without merging
// keeps it for the human, and the next run starts a fresh one. A worktree that is done is removed
// with its branch when the parent's next run starts, or by `kabane loop prune`. Only a worktree the
// loop made, under KABANE_HOME/loops, is ever removed, and never one a live run works in or a
// landing by hand holds (`Worktree.lock`).
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { err, ok, type Result } from "@cabane/core";
import { Land } from "./land";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Prune {
	type Deps = { home: string; git?: Worktree.Git; gh?: Land.Gh };

	/** Whether a worktree goes on, stays for the human, or is done with: and why, in a clause. */
	type Verdict =
		| { kind: "working"; why: string }
		| { kind: "kept"; why: string }
		| { kind: "merged"; why: string; squashed: boolean };

	/** Where the work on `branch`, run `run`'s worktree's branch, stands. */
	export const verdict = async (
		deps: Deps,
		run: RunStore.Run,
		branch: string,
	): Promise<Result<Verdict>> => {
		const { pr, projectDir } = run;
		const state = pr ? await Land.prState(deps.gh, projectDir, pr) : undefined;
		if (pr && state?.ok) {
			if (state.value.state === "OPEN")
				return ok({ kind: "working", why: `pull request ${pr} is open` });
			if (state.value.state === "CLOSED")
				return ok({
					kind: "kept",
					why: `pull request ${pr} was closed without merging`,
				});
			// Merged as the branch is now: a commit made after the merge is work it does not have.
			const tip = await (deps.git ?? Worktree.git)(projectDir, [
				"rev-parse",
				`refs/heads/${branch}`,
			]);
			if (tip.ok && tip.value.trim() === state.value.headRefOid)
				return ok({
					kind: "merged",
					why: `pull request ${pr} is merged`,
					squashed: true,
				});
		}
		const merged = await Worktree.merged(projectDir, branch, deps.git);
		if (!merged.ok) return merged;
		return ok(
			merged.value
				? {
						kind: "merged",
						why: `branch ${branch} is merged into HEAD`,
						squashed: false,
					}
				: { kind: "working", why: `branch ${branch} is not merged into HEAD` },
		);
	};

	const loopMade = (home: string, dir: string): boolean => {
		const inside = relative(RunStore.loopsDir(home), dir);
		return inside !== "" && !inside.startsWith("..");
	};

	/**
	 * Remove run `run`'s worktree `dir` and its branch, which `merged` says are done with, and say
	 * so on the run's trace.
	 */
	export const remove = async (
		deps: Deps,
		run: RunStore.Run,
		dir: string,
		branch: string,
		merged: Extract<Verdict, { kind: "merged" }>,
	): Promise<Result<void>> => {
		if (!loopMade(deps.home, dir))
			return err(
				new Error(
					`${dir} is not a worktree the loop made, so the loop does not remove it`,
				),
			);
		const removed = await Worktree.remove(
			run.projectDir,
			dir,
			branch,
			merged.squashed,
			deps.git,
		);
		if (!removed.ok) return removed;
		const log = RunStore.eventLog(deps.home, run.id);
		if (log.ok)
			log.value.append({
				type: "pruned",
				summary: `worktree ${dir} and branch ${branch} removed: ${merged.why}`,
				data: { dir, branch },
			});
		return ok(undefined);
	};

	/** What `prune` did with one worktree. */
	export type Pruned = {
		runId: string;
		dir: string;
		branch: string;
		removed: boolean;
		why: string;
	};

	// One worktree, by its newest run: removed when it is done with. Undefined when it is no
	// longer one of its repository's worktrees.
	const one = async (
		deps: Deps,
		run: RunStore.Run,
		dir: string,
	): Promise<Result<Pruned | undefined>> => {
		const branch = await Worktree.branchOf(run.projectDir, dir, deps.git);
		if (!branch.ok) return branch;
		if (branch.value === undefined) return ok(undefined);
		const at = { runId: run.id, dir, branch: branch.value };
		const said = await verdict(deps, run, branch.value);
		if (!said.ok) return said;
		if (said.value.kind !== "merged")
			return ok({ ...at, removed: false, why: said.value.why });
		const removed = await remove(deps, run, dir, branch.value, said.value);
		return ok({
			...at,
			removed: removed.ok,
			why: removed.ok ? said.value.why : removed.error.message,
		});
	};

	/**
	 * Remove every worktree on this device that is done with, with its branch: each one's newest
	 * run says. A worktree a live run works in, or one already gone, is not looked at, and one that
	 * cannot be judged (its repository is gone) is kept, saying why.
	 */
	export const prune = async (deps: Deps): Promise<Result<Pruned[]>> => {
		const runs = RunStore.list(deps.home);
		if (!runs.ok) return runs;
		const busy = new Set(
			runs.value
				.filter((r) => RunStore.isLive(r.status))
				.map((r) => r.worktree),
		);
		const seen = new Set<string>();
		const pruned: Pruned[] = [];
		// Newest first: a worktree runs went on in is judged by the last of them.
		for (const run of runs.value) {
			const dir = run.worktree;
			if (dir === undefined || seen.has(dir)) continue;
			seen.add(dir);
			if (busy.has(dir) || !existsSync(dir)) continue;
			const held = Worktree.lock(dir, "kabane loop prune");
			if (!held.ok) {
				pruned.push({
					runId: run.id,
					dir,
					branch: "",
					removed: false,
					why: held.error.message,
				});
				continue;
			}
			const judged = await one(deps, run, dir).finally(held.value);
			if (!judged.ok)
				pruned.push({
					runId: run.id,
					dir,
					branch: "",
					removed: false,
					why: judged.error.message,
				});
			else if (judged.value) pruned.push(judged.value);
		}
		return ok(pruned);
	};
}
