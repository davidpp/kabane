// A run's git worktree, and the checkpoints committed in it. On unless the run opts out: `git
// worktree add` on a branch of its own beside the run's files, or the worktree of the parent's
// last run when its branch is not merged yet, recorded in run.json, never removed by the loop. A
// checkpoint is a commit of everything in the worktree after a green gate; a rollback resets the
// worktree to one of them.
//
// Nothing here commits into, or resets, the user's own checkout: `checkpoint` and `rollback`
// refuse any directory that is not a linked worktree, so a run without one cannot reach them by
// mistake.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result, trySync } from "@cabane/core";
import { Exec } from "./exec";
import type { RunStore } from "./store";

export namespace Worktree {
	/** `git <args>` in `cwd`: its stdout, or an error carrying what git said. */
	export type Git = Exec.Tool;

	/** The user's own git. */
	export const git: Git = Exec.tool("git");

	/** Where run `runId`'s worktree goes: inside the run's own directory. */
	export const dirFor = (runDir: string): string => join(runDir, "worktree");

	export const branchFor = (runId: string): string => `kabane-loop/${runId}`;

	/** A worktree of `projectDir`'s HEAD at `dir`, on a new branch `branch`. */
	export const add = async (
		projectDir: string,
		dir: string,
		branch: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const added = await run(projectDir, [
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

	/**
	 * Whether `dir` is in a git repository: a `.git` (a directory, or a linked worktree's file) in
	 * it or above it. Read off the filesystem rather than git's error text, which is localized.
	 */
	export const inRepo = (dir: string): boolean => {
		for (let at = resolve(dir); ; at = dirname(at)) {
			if (existsSync(join(at, ".git"))) return true;
			if (dirname(at) === at) return false;
		}
	};

	const real = (path: string): string | undefined => {
		const found = trySync(() => realpathSync(path));
		return found.ok ? found.value : undefined;
	};

	const BRANCH = "branch refs/heads/";

	/**
	 * The branch checked out in `dir` when it is one of `projectDir`'s repository's worktrees and
	 * still on disk; undefined when it was removed or deleted, or its HEAD is detached.
	 */
	export const branchOf = async (
		projectDir: string,
		dir: string,
		run: Git = git,
	): Promise<Result<string | undefined>> => {
		const wanted = real(dir);
		if (wanted === undefined) return ok(undefined);
		const listed = await run(projectDir, ["worktree", "list", "--porcelain"]);
		if (!listed.ok) return listed;
		for (const entry of listed.value.split("\n\n")) {
			const lines = entry.split("\n");
			const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
			if (path === undefined || real(path) !== wanted) continue;
			return ok(lines.find((l) => l.startsWith(BRANCH))?.slice(BRANCH.length));
		}
		return ok(undefined);
	};

	/** Whether `branch`'s tip is in `projectDir`'s HEAD: merged, or never moved past it. */
	export const merged = async (
		projectDir: string,
		branch: string,
		run: Git = git,
	): Promise<Result<boolean>> => {
		const found = await run(projectDir, [
			"for-each-ref",
			"--merged",
			"HEAD",
			"--format=%(refname)",
			`refs/heads/${branch}`,
		]);
		return found.ok ? ok(found.value.trim() !== "") : found;
	};

	/** A checkout's HEAD: its commit, and its branch unless HEAD is detached. */
	export type Head = { branch?: string; sha: string };

	export const head = async (
		dir: string,
		run: Git = git,
	): Promise<Result<Head>> => {
		const sha = await run(dir, ["rev-parse", "HEAD"]);
		if (!sha.ok) return sha;
		// Exits 1, quietly, on a detached HEAD.
		const branch = await run(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
		const name = branch.ok ? branch.value.trim() : "";
		return ok({ ...(name ? { branch: name } : {}), sha: sha.value.trim() });
	};

	/** Where `dir` sits inside its repository, relative to the top: "" at the top. */
	export const prefixOf = async (
		dir: string,
		run: Git = git,
	): Promise<Result<string>> => {
		const shown = await run(dir, ["rev-parse", "--show-prefix"]);
		return shown.ok ? ok(shown.value.trim().replace(/\/$/, "")) : shown;
	};

	/** Whether `path`, relative to the repository top, is in `dir`'s HEAD. */
	export const has = async (
		dir: string,
		path: string,
		run: Git = git,
	): Promise<boolean> =>
		(await run(dir, ["cat-file", "-e", `HEAD:${path}`])).ok;

	// A linked worktree's git dir is its own, under the main repository's common dir; the main
	// checkout's is the common dir itself.
	const linked = async (dir: string, run: Git): Promise<Result<void>> => {
		const own = await run(dir, [
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
		]);
		if (!own.ok) return own;
		const common = await run(dir, [
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
	export const checkpoint = async (
		dir: string,
		message: string,
		run: Git = git,
	): Promise<Result<string | undefined>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const added = await run(dir, ["add", "-A"]);
		if (!added.ok) return added;
		const staged = await run(dir, ["status", "--porcelain"]);
		if (!staged.ok) return staged;
		if (staged.value.trim() === "") return ok(undefined);
		const committed = await run(dir, ["commit", "-q", "-m", message]);
		if (!committed.ok) return committed;
		const sha = await run(dir, ["rev-parse", "HEAD"]);
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
	export const reset = async (
		dir: string,
		sha: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const reset = await run(dir, ["reset", "-q", "--hard", sha]);
		if (!reset.ok) return reset;
		const cleaned = await run(dir, ["clean", "-q", "-fd"]);
		return cleaned.ok ? ok(undefined) : cleaned;
	};

	/**
	 * Rebase the worktree at `dir` onto commit `onto`. A rebase that stops on a conflict is
	 * aborted, so the branch is left as it was, and the error names the files that conflicted.
	 */
	export const rebase = async (
		dir: string,
		onto: string,
		run: Git = git,
	): Promise<Result<void>> => {
		const isLinked = await linked(dir, run);
		if (!isLinked.ok) return isLinked;
		const rebased = await run(dir, ["rebase", "-q", onto]);
		if (rebased.ok) return ok(undefined);
		const conflicted = await run(dir, [
			"diff",
			"--name-only",
			"--diff-filter=U",
		]);
		await run(dir, ["rebase", "--abort"]);
		const files = conflicted.ok
			? conflicted.value.split("\n").filter((f) => f.trim() !== "")
			: [];
		return err(
			files.length > 0
				? new Error(`conflicts in ${files.join(", ")}`)
				: rebased.error,
		);
	};

	/** The trace's line for a rollback. */
	export const rolledBack = (sha: string, by: string): RunStore.EventDraft => ({
		type: "rollback",
		summary: `worktree reset to checkpoint ${sha.slice(0, 12)} by ${by}`,
		data: { sha, by },
	});
}
