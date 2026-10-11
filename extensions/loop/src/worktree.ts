// A run's own git worktree, and the checkpoints committed in it. Opt-in per run: `git worktree
// add` on a branch of its own beside the run's files, recorded in run.json, never removed by the
// loop. A checkpoint is a commit of everything in the worktree after a green gate; a rollback
// resets the worktree to one of them.
//
// Nothing here commits into, or resets, the user's own checkout: `checkpoint` and `rollback`
// refuse any directory that is not a linked worktree, so a run without one cannot reach them by
// mistake.
import { join } from "node:path";
import { err, ok, type Result, trySync } from "@cabane/core";
import type { RunStore } from "./store";

export namespace Worktree {
	/** `git -C <cwd> <args>`: its stdout, or an error carrying what git said. */
	export type Git = (cwd: string, args: string[]) => Result<string>;

	const git: Git = (cwd, args) => {
		const ran = trySync(() =>
			Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore" }),
		);
		if (!ran.ok) return ran;
		return ran.value.success
			? ok(ran.value.stdout.toString())
			: err(
					new Error(
						`git ${args.join(" ")} failed in ${cwd}: ${ran.value.stderr.toString().trim()}`,
					),
				);
	};

	/** Where run `runId`'s worktree goes: inside the run's own directory. */
	export const dirFor = (runDir: string): string => join(runDir, "worktree");

	export const branchFor = (runId: string): string => `kabane-loop/${runId}`;

	/** A worktree of `projectDir`'s HEAD at `dir`, on a new branch `branch`. */
	export const add = (
		projectDir: string,
		dir: string,
		branch: string,
		run: Git = git,
	): Result<void> => {
		const added = run(projectDir, [
			"worktree",
			"add",
			"-q",
			"-b",
			branch,
			dir,
			"HEAD",
		]);
		return added.ok ? ok(undefined) : added;
	};

	// A linked worktree's git dir is its own, under the main repository's common dir; the main
	// checkout's is the common dir itself.
	const linked = (dir: string, run: Git): Result<void> => {
		const own = run(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
		if (!own.ok) return own;
		const common = run(dir, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (!common.ok) return common;
		return own.value.trim() !== common.value.trim()
			? ok(undefined)
			: err(
					new Error(`${dir} is not a linked worktree; refusing to change it`),
				);
	};

	/**
	 * Commit everything in the worktree at `dir` as a checkpoint: its sha, or undefined when there
	 * was nothing to commit. The user's own git config and hooks apply, as to any commit of theirs.
	 */
	export const checkpoint = (
		dir: string,
		message: string,
		run: Git = git,
	): Result<string | undefined> => {
		const isLinked = linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const added = run(dir, ["add", "-A"]);
		if (!added.ok) return added;
		const staged = run(dir, ["status", "--porcelain"]);
		if (!staged.ok) return staged;
		if (staged.value.trim() === "") return ok(undefined);
		const committed = run(dir, ["commit", "-q", "-m", message]);
		if (!committed.ok) return committed;
		const sha = run(dir, ["rev-parse", "HEAD"]);
		return sha.ok ? ok(sha.value.trim()) : sha;
	};

	const SHA = /^[0-9a-f]{4,40}$/;

	/** The one checkpoint `given` names, as a full sha or a prefix of one. */
	export const match = (
		checkpoints: readonly string[],
		given: string,
	): Result<string> => {
		const wanted = given.trim().toLowerCase();
		const found = SHA.test(wanted)
			? checkpoints.filter((sha) => sha.startsWith(wanted))
			: [];
		if (found.length === 1 && found[0] !== undefined) return ok(found[0]);
		const listed = checkpoints.map((sha) => sha.slice(0, 12)).join(", ");
		return err(
			new Error(
				found.length > 1
					? `${given} names more than one checkpoint: give more of the sha (${listed})`
					: `${given} is not one of this run's checkpoints${listed ? `: ${listed}` : "; it has none"}`,
			),
		);
	};

	/**
	 * Reset the worktree at `dir` to checkpoint `sha`: tracked files to the commit, and untracked
	 * ones it did not have removed (ignored files are left alone).
	 */
	export const reset = (
		dir: string,
		sha: string,
		run: Git = git,
	): Result<void> => {
		const isLinked = linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const reset = run(dir, ["reset", "-q", "--hard", sha]);
		if (!reset.ok) return reset;
		const cleaned = run(dir, ["clean", "-q", "-fd"]);
		return cleaned.ok ? ok(undefined) : cleaned;
	};

	/** The trace's line for a rollback. */
	export const rolledBack = (sha: string, by: string): RunStore.EventDraft => ({
		type: "rollback",
		summary: `worktree reset to checkpoint ${sha.slice(0, 12)} by ${by}`,
		data: { sha, by },
	});
}
