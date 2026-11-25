// The worktrees a run's subtask claims work in, with `isolation: worktree` (`LoopConfig`): each
// claim works in one of its own, on a branch of its own cut from the run's worktree's HEAD, under
// the run's directory (`trees/<n>`), and its session and its gates run there. A subtask holds its
// worktree from its claim until its work lands on the run's branch, so the claim after a red gate,
// a conflict or a runner's death finds what the last one left. When its session closes it, the
// run's HEAD is merged into its worktree first (`catchUp`), and the gates run on that merge: one
// that conflicts is left there, mid-merge, for the subtask's next session to resolve, before any
// gate runs. A green pass then fast-forwards the run's branch to the subtask's (`land`), so what
// the gates ran on is what lands. The whole pass holds the run's merge queue (`Checks`), so the
// run's HEAD cannot move between the merge in and the landing. A worktree whose work has landed is
// free: with `reuse`, kept for the next subtask, reset to the run's HEAD with what git ignores
// (build output) left warm; without, removed. The run keeps at most `maxWorktrees` (its concurrency
// when unset), and a subtask waits for one. The user's `setup` command readies a worktree for a
// subtask, and the run's own worktree once per runner for the claims that work there; nothing else
// is installed. When the run ends, the free ones are removed, and one still
// holding work that never landed is left, with its branch, for a human.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Result, type Task } from "@kabane/core";
import { Gates } from "./gates";
import { err, ok } from "./result";
import { RunState } from "./state";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace ClaimTrees {
	type Ctx = RunState.Ctx;

	/** A subtask's worktree, by its top, and the branch its work is on there. */
	export type Tree = { dir: string; branch: string };

	const label = (task: { shortId?: string; id: string }): string =>
		task.shortId ?? task.id;

	const gitOf = (ctx: Ctx): Worktree.Git => ctx.deps.git ?? Worktree.git;

	/** The run's subtask worktrees, oldest first. */
	export const all = (run: RunStore.Run): RunStore.Tree[] => run.trees ?? [];

	/** The most worktrees the run keeps at once: `maxWorktrees`, else its concurrency. */
	export const cap = (run: RunStore.Run): number =>
		run.config.maxWorktrees ?? RunStore.concurrency(run);

	/** Where the run's sessions and gates work in each of its subtask worktrees. */
	export const projectDirs = (run: RunStore.Run): string[] =>
		all(run).map((t) => RunStore.projectIn(run, t.dir));

	const setTrees = (
		ctx: Ctx,
		change: (trees: RunStore.Tree[]) => RunStore.Tree[],
	): void => RunState.save(ctx, { ...ctx.run, trees: change(all(ctx.run)) });

	// Record `dir` as held by `held`, or free without it, where it stands among the run's trees.
	const hold = (ctx: Ctx, dir: string, held?: RunStore.Tree["held"]): void =>
		setTrees(ctx, (trees) => {
			const tree = { dir, ...(held ? { held } : {}) };
			return trees.some((t) => t.dir === dir)
				? trees.map((t) => (t.dir === dir ? tree : t))
				: [...trees, tree];
		});

	const forget = (ctx: Ctx, dir: string): void =>
		setTrees(ctx, (trees) => trees.filter((t) => t.dir !== dir));

	const warn = (ctx: Ctx, summary: string, task?: string): void =>
		RunState.event(ctx, {
			type: "warning",
			summary,
			...(task ? { task } : {}),
		});

	// `trees/1`, `trees/2`…: the first number no worktree of the run's has.
	const nextDir = (ctx: Ctx): string => {
		const root = join(RunStore.paths(ctx.deps.home, ctx.run.id).dir, "trees");
		const taken = new Set(all(ctx.run).map((t) => t.dir));
		let n = 1;
		while (taken.has(join(root, String(n)))) n += 1;
		return join(root, String(n));
	};

	// A branch of the run's own, named for the subtask, beside the run's: `jcab-81-title--jcab-82`.
	const branchFor = (
		ctx: Ctx,
		runTree: string,
		task: Task,
	): Promise<Result<string>> =>
		Worktree.unused(
			runTree,
			`${RunStore.branchOf(ctx.run)}--${label(task)
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "")}`,
			gitOf(ctx),
		);

	// The user's setup command in the worktree's project folder, heard by the run's stop, and on the
	// trace once it has run.
	const setUp = async (
		ctx: Ctx,
		dir: string,
		task?: string,
	): Promise<Result<void>> => {
		const command = ctx.run.config.setup;
		if (command === undefined) return ok(undefined);
		const [ran] = await Gates.run(
			{ setup: command },
			RunStore.projectIn(ctx.run, dir),
			{ KABANE_LOOP: "1", KABANE_LOOP_RUN: ctx.run.id },
			ctx.stopping.signal,
		);
		if (ran === undefined || ran.ok) {
			RunState.event(ctx, {
				type: "setup",
				summary: `setup \`${command}\` ran in ${dir}`,
				...(task ? { task } : {}),
			});
			return ok(undefined);
		}
		return err(
			new Error(
				`${Gates.describe(ran)} in ${dir}: \`${command}\`${ran.tail ? `\n${ran.tail}` : ""}`,
			),
		);
	};

	/**
	 * Ready the run's own worktree for the claims that work in it (a single issue, every subtask of a
	 * run that shares its tree): the setup runs there once per runner, so a runner started again on a
	 * reused worktree readies it too. An error when it fails, which stops the run.
	 */
	export const readyRunTree = async (ctx: Ctx): Promise<Result<void>> => {
		const runTree = ctx.run.worktree;
		if (runTree === undefined || ctx.runTreeReady) return ok(undefined);
		const ready = await setUp(ctx, runTree);
		if (!ready.ok)
			return err(
				new Error(`the run's worktree was not readied: ${ready.error.message}`),
			);
		ctx.runTreeReady = true;
		return ready;
	};

	/**
	 * The worktree `task`'s claim works in: the one it holds, as its last claim left it, or else one
	 * readied for it from the run's HEAD, a free one reset or a new one made, then set up. Undefined
	 * while the run keeps as many as it may and none is free; an error when one could not be readied,
	 * which leaves it free again.
	 */
	export const acquire = async (
		ctx: Ctx,
		task: Task,
	): Promise<Result<Tree | undefined>> => {
		const runTree = ctx.run.worktree;
		if (runTree === undefined)
			return err(new Error("the run has no worktree to cut a subtask's from"));
		const own = all(ctx.run).find((t) => t.held?.taskId === task.id);
		if (own?.held && existsSync(own.dir))
			return ok({ dir: own.dir, branch: own.held.branch });
		if (own?.held) {
			forget(ctx, own.dir);
			warn(
				ctx,
				`worktree ${own.dir} of ${label(task)} is gone: ${label(task)} starts again from the run's HEAD, and its branch ${own.held.branch} keeps what it committed`,
				label(task),
			);
		}
		// A free worktree whose directory is gone is no longer one the run keeps.
		for (const gone of all(ctx.run).filter(
			(t) => !t.held && !existsSync(t.dir),
		))
			forget(ctx, gone.dir);
		const spare = all(ctx.run).find((t) => !t.held);
		if (spare === undefined && all(ctx.run).length >= cap(ctx.run))
			return ok(undefined);
		const dir = spare?.dir ?? nextDir(ctx);
		const branch = await branchFor(ctx, runTree, task);
		if (!branch.ok) return branch;
		// Held before git makes it, so a runner that dies meanwhile leaves it recorded.
		hold(ctx, dir, { taskId: task.id, branch: branch.value });
		const head = await gitOf(ctx)(runTree, ["rev-parse", "HEAD"]);
		const readied = !head.ok
			? head
			: spare
				? await Worktree.switchTo(
						dir,
						branch.value,
						head.value.trim(),
						gitOf(ctx),
					)
				: await Worktree.add(runTree, dir, branch.value, gitOf(ctx));
		const ready = readied.ok ? await setUp(ctx, dir, label(task)) : readied;
		if (ready.ok) return ok({ dir, branch: branch.value });
		await release(ctx, { dir, branch: branch.value }, existsSync(dir));
		return err(
			new Error(
				`the worktree for ${label(task)} was not readied: ${ready.error.message}`,
			),
		);
	};

	// Free `tree`, whose branch holds nothing the run's lacks: detached and kept for reuse, or
	// removed with its branch. A worktree git will not let go of is kept free, and said so.
	const release = async (
		ctx: Ctx,
		tree: Tree,
		exists: boolean,
	): Promise<void> => {
		const runTree = ctx.run.worktree;
		if (!exists || runTree === undefined) {
			forget(ctx, tree.dir);
			return;
		}
		const freed = ctx.run.config.reuse
			? await Worktree.detach(tree.dir, tree.branch, runTree, gitOf(ctx))
			: await Worktree.remove(
					runTree,
					tree.dir,
					tree.branch,
					false,
					gitOf(ctx),
				);
		if (!ctx.run.config.reuse && freed.ok) forget(ctx, tree.dir);
		else hold(ctx, tree.dir);
		if (!freed.ok)
			warn(ctx, `worktree ${tree.dir} not freed: ${freed.error.message}`);
	};

	/**
	 * Merge the run's HEAD into `tree`, as the commit `message` when it cannot fast-forward: the
	 * files it left conflicted there, mid-merge, for the subtask's next session to resolve; none
	 * when it merged cleanly or had nothing to bring in.
	 */
	export const catchUp = async (
		ctx: Ctx,
		tree: Tree,
		message: string,
	): Promise<Result<string[]>> => {
		const runTree = ctx.run.worktree;
		if (runTree === undefined)
			return err(new Error("the run has no worktree to merge from"));
		const git = gitOf(ctx);
		const head = await git(runTree, ["rev-parse", "HEAD"]);
		return head.ok
			? Worktree.mergeKeepingConflicts(
					tree.dir,
					head.value.trim(),
					message,
					git,
				)
			: head;
	};

	/**
	 * Fast-forward the run's branch to `tree`'s, which `catchUp` brought the run's HEAD into, and
	 * free `tree`: the run's branch's commit after. An error, `tree` still held, when the run's
	 * branch has commits `tree`'s lacks.
	 */
	export const land = async (ctx: Ctx, tree: Tree): Promise<Result<string>> => {
		const runTree = ctx.run.worktree;
		if (runTree === undefined)
			return err(new Error("the run has no worktree to land on"));
		const landed = await Worktree.fastForward(runTree, tree.branch, gitOf(ctx));
		if (!landed.ok)
			return err(
				new Error(
					`the run's branch ${RunStore.branchOf(ctx.run)} did not fast-forward to ${tree.branch}: ${landed.error.message}`,
				),
			);
		await release(ctx, tree, true);
		return landed;
	};

	/**
	 * Let go of the worktree `tree` holds for a subtask whose work will not merge (it was cancelled
	 * or deleted): free for the next, its branch kept with what it committed.
	 */
	export const abandon = (ctx: Ctx, tree: RunStore.Tree, why: string): void => {
		if (!tree.held) return;
		hold(ctx, tree.dir);
		warn(
			ctx,
			`worktree ${tree.dir} freed: ${why}; its branch ${tree.held.branch} keeps what it committed`,
		);
	};

	// Whether the worktree at `dir` holds nothing the run's branch lacks: no change left in it, and
	// its HEAD already in the run's. What cannot be told counts as work.
	const empty = async (
		ctx: Ctx,
		dir: string,
		runTree: string,
	): Promise<boolean> => {
		const git = gitOf(ctx);
		const [status, head] = await Promise.all([
			git(dir, ["status", "--porcelain"]),
			git(runTree, ["rev-parse", "HEAD"]),
		]);
		if (!status.ok || status.value.trim() !== "" || !head.ok) return false;
		return (
			await git(dir, ["merge-base", "--is-ancestor", "HEAD", head.value.trim()])
		).ok;
	};

	/**
	 * As the run ends: remove every worktree that holds nothing the run's branch lacks, free or held
	 * by a subtask whose session never changed it, and say which still hold work that never landed,
	 * left with their branches for a human.
	 */
	export const close = async (ctx: Ctx): Promise<void> => {
		const runTree = ctx.run.worktree;
		if (runTree === undefined) return;
		for (const tree of all(ctx.run)) {
			if (!existsSync(tree.dir)) {
				forget(ctx, tree.dir);
				continue;
			}
			if (tree.held && !(await empty(ctx, tree.dir, runTree))) {
				warn(
					ctx,
					`worktree ${tree.dir} is left with work on branch ${tree.held.branch} that never merged into ${RunStore.branchOf(ctx.run)}`,
				);
				continue;
			}
			const removed = tree.held
				? await Worktree.remove(
						runTree,
						tree.dir,
						tree.held.branch,
						false,
						gitOf(ctx),
					)
				: await Worktree.drop(runTree, tree.dir, gitOf(ctx));
			if (removed.ok) forget(ctx, tree.dir);
			else
				warn(ctx, `worktree ${tree.dir} not removed: ${removed.error.message}`);
		}
	};
}
