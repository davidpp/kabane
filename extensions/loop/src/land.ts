// Landing a completed run's branch, as its `land` setting says: in the run's worktree, fetch the
// branch the run started from and rebase onto its latest commit, gate the result again when the
// rebase moved anything, push the branch and open a pull request against the base, or push to the
// one already open for it. The user's own git and gh do all of it, with their own credentials and
// config; the loop adds none. The outcome is run.json's `landing`, and the pull request its `pr`.
// A landing that fails leaves the run completed: the work is done and its gates were green, only
// getting it onto the base is left, and the branch stays as the run left it.
import { err, ok, type Result, type Task, trySync } from "@cabane/core";
import { z } from "zod";
import { Checks } from "./checks";
import { Exec } from "./exec";
import { Gates } from "./gates";
import { LoopPlan } from "./plan";
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

	/** `gh <args>` in `cwd`: GitHub's CLI, which opens and reads the run's pull request. */
	export type Gh = Exec.Tool;

	/** The user's own gh, signed in as they signed it in. */
	const gh: Gh = Exec.tool("gh");

	const PrSchema = z.object({ url: z.string(), state: z.string() });

	// The pull request already open for `branch`, when there is one: a later run on the parent
	// going on in the same worktree pushes to it rather than opening another.
	const openPr = async (
		run: Gh,
		dir: string,
		branch: string,
	): Promise<string | undefined> => {
		const viewed = await run(dir, [
			"pr",
			"view",
			branch,
			"--json",
			"url,state",
		]);
		if (!viewed.ok) return undefined;
		const json = trySync((): unknown => JSON.parse(viewed.value));
		const pr = PrSchema.safeParse(json.ok ? json.value : undefined);
		return pr.success && pr.data.state === "OPEN" ? pr.data.url : undefined;
	};

	const lines = (items: readonly string[], none: string): string =>
		items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : none;

	/**
	 * The pull request's body: the parent's brief, the gates' last results, and what the lenses
	 * found, each finding with where it stands.
	 */
	const body = (run: RunStore.Run, plan: LoopPlan.Plan): string => {
		const gates = run.gateRuns.at(-1)?.results ?? [];
		const findings = plan.nodes
			.filter((n) => n.finding)
			.map(({ task }) => {
				const tags = [LoopPlan.severityOf(task), LoopPlan.lensOf(task)].filter(
					(t) => t !== undefined,
				);
				return `${task.shortId ?? task.id}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}: ${task.title} [${task.state}]`;
			});
		return [
			plan.parent.description?.trim() || plan.parent.title,
			"",
			"## Gates",
			"",
			lines(gates.map(Gates.describe), "No gates configured."),
			"",
			"## Lens findings",
			"",
			lines(
				findings,
				run.config.lenses.length > 0 ? "None." : "No lenses configured.",
			),
			"",
			"---",
			`Opened by kabane loop run \`${run.id}\`. ${run.parentShortId} waits on this review in the tracker: merging is yours, and closing ${run.parentShortId} after.`,
		].join("\n");
	};

	// Push the branch to the base's remote and open its pull request, or find the one already open.
	const toPr = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
		placed: OnBase,
	): Promise<Result<string, Outcome>> => {
		const git = ctx.deps.git ?? Worktree.git;
		const run = ctx.deps.gh ?? gh;
		const { dir, remote, base, rebased } = placed;
		const keep = rebased ? { rebased } : {};
		const named = await git(dir, ["symbolic-ref", "--short", "HEAD"]);
		if (!named.ok)
			return err(
				notLanded(`the worktree is on no branch: ${named.error.message}`, keep),
			);
		const branch = named.value.trim();
		// A later run on the parent rebases the branch a pull request already has: a lease, so a
		// push never overwrites a commit someone else pushed to it.
		const pushed = await git(dir, [
			"push",
			"-q",
			"--force-with-lease",
			remote,
			branch,
		]);
		if (!pushed.ok) return err(notLanded(pushed.error.message, keep));
		const open = await openPr(run, dir, branch);
		if (open !== undefined) return ok(open);
		const created = await run(dir, [
			"pr",
			"create",
			"--base",
			base,
			"--head",
			branch,
			"--title",
			plan.parent.title,
			"--body",
			body(ctx.run, plan),
		]);
		if (!created.ok)
			return err(
				notLanded(
					`branch ${branch} is pushed, but no pull request was opened: ${created.error.message}`,
					keep,
				),
			);
		const url = created.value
			.split("\n")
			.map((l) => l.trim())
			.findLast((l) => l.startsWith("https://"));
		return url
			? ok(url)
			: err(
					notLanded(
						`gh pr create printed no pull request URL: ${created.value.trim()}`,
						keep,
					),
				);
	};

	const record = (
		ctx: Ctx,
		outcome: Outcome,
		pr?: string,
	): RunStore.Landing => {
		const landing: RunStore.Landing = {
			at: ctx.now().toISOString(),
			...outcome,
		};
		RunState.save(ctx, { ...ctx.run, landing, ...(pr ? { pr } : {}) });
		RunState.event(ctx, {
			type: landing.ok ? "landed" : "warning",
			summary: landing.summary,
			...(pr ? { data: { pr } } : {}),
		});
		return landing;
	};

	/**
	 * Land the run's branch: onto its base, pushed, with a pull request open. What happened is
	 * recorded on the run, the pull request's URL with it, and on its trace.
	 */
	export const land = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
	): Promise<RunStore.Landing> => {
		const placed = await onBase(ctx, plan.parent);
		if (!placed.ok) return record(ctx, placed.error);
		const pr = await toPr(ctx, plan, placed.value);
		if (!pr.ok) return record(ctx, pr.error);
		const { said, rebased } = placed.value;
		return record(
			ctx,
			{
				ok: true,
				summary: `${said}; pull request ${pr.value} is open.`,
				...(rebased ? { rebased } : {}),
			},
			pr.value,
		);
	};
}
