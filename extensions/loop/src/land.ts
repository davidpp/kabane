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
import { RunStore } from "./store";
import { Worktree } from "./worktree";

export namespace Land {
	type Ctx = RunState.Ctx;

	type Outcome = Omit<RunStore.Landing, "at">;

	const short = (sha: string): string => sha.slice(0, 12);

	// Whatever a tool or the repository's config put in it, a summary is kept and commented on,
	// so it never carries a credential.
	const notLanded = (why: string, extra: Partial<Outcome> = {}): Outcome => ({
		ok: false,
		summary: Exec.redact(`Not landed: ${why}.`),
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
		/** The run's own branch, the one checked out in its worktree. */
		branch: string;
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
		// Before anything changes: a session that switched branches must not have another branch
		// rebased or published in the run's name.
		const branch = RunStore.branchOf(ctx.run);
		const named = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
		const on = named.ok ? named.value.trim() : "";
		if (on !== branch)
			return err(
				notLanded(
					`the worktree is on ${on === "" ? "a detached HEAD" : `branch ${on}`}, not the run's branch ${branch}; nothing was changed`,
				),
			);
		const remote = await remoteOf(git, dir, base);
		const fetched = await git(dir, ["fetch", "-q", remote, base]);
		if (!fetched.ok) return err(notLanded(fetched.error.message));
		const onto = await revParse(git, dir, "FETCH_HEAD");
		if (!onto.ok) return err(notLanded(onto.error.message));
		const from = await revParse(git, dir, "HEAD");
		if (!from.ok) return err(notLanded(from.error.message));
		// The remote by its name; a base that tracks a URL is shown without its credentials.
		const target = `${Exec.redact(remote)}/${base} (${short(onto.value)})`;
		const contained = await git(dir, [
			"merge-base",
			"--is-ancestor",
			onto.value,
			from.value,
		]);
		if (contained.ok)
			return ok({
				dir,
				remote,
				base,
				branch,
				said: `The branch is on ${target}`,
			});
		RunState.save(ctx, { ...ctx.run, landingFrom: from.value });
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
		// Every gate passed, not only none failed: a stop skips the gates still to run.
		if (pass.ok && !stopping(ctx))
			return ok({
				dir,
				remote,
				base,
				branch,
				rebased: moved,
				said: `Rebased onto ${target}${Gates.configured(ctx.run.config.gates) ? ", gates green again" : ""}`,
			});
		const failed = pass.results.find((r) => !r.ok);
		const why =
			failed && !stopping(ctx)
				? `the gate ${Gates.describe(failed)}`
				: "the run was stopped before its gates passed again";
		return err(
			notLanded(
				`after rebasing onto ${target}, ${why}; ${await putBack(ctx, dir, from.value)}`,
				{ rebased: moved },
			),
		);
	};

	/** Whether the run is stopping: nothing more goes out, and a gate pass is not complete. */
	const stopping = (ctx: Ctx): boolean =>
		ctx.stopRequested || ctx.stopping.signal.aborted;

	// The branch back at the tip the run left it at, after a rebase that is not landing.
	const putBack = async (
		ctx: Ctx,
		dir: string,
		tip: string,
	): Promise<string> => {
		const reset = await Worktree.reset(dir, tip, ctx.deps.git ?? Worktree.git);
		return reset.ok
			? `the branch is back at ${short(tip)}, as the run left it`
			: `the branch could not be put back at ${short(tip)}: ${reset.error.message}`;
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

	const StateSchema = z.object({
		state: z.enum(["OPEN", "CLOSED", "MERGED"]),
		headRefOid: z.string(),
	});

	/** Where a pull request stands on GitHub, and the commit its branch was at. */
	type PrState = z.infer<typeof StateSchema>;

	/** Ask gh where pull request `url` stands. */
	export const prState = async (
		run: Gh | undefined,
		cwd: string,
		url: string,
	): Promise<Result<PrState>> => {
		const viewed = await (run ?? gh)(cwd, [
			"pr",
			"view",
			url,
			"--json",
			"state,headRefOid",
		]);
		if (!viewed.ok) return viewed;
		const json = trySync((): unknown => JSON.parse(viewed.value));
		if (!json.ok) return json;
		const parsed = StateSchema.safeParse(json.value);
		return parsed.success
			? ok(parsed.data)
			: err(new Error(`gh pr view ${url} said: ${viewed.value.trim()}`));
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
			`Opened by kabane loop run \`${run.id}\`. ${run.parentShortId} waits on this review in the tracker: merging is yours. The next \`kabane loop start\` or \`kabane loop prune\` that sees this pull request merged moves ${run.parentShortId} to done, or back to next if it was closed unmerged.`,
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
		const { dir, remote, base, branch, rebased } = placed;
		const keep = rebased ? { rebased } : {};
		// A later run on the parent rebases the branch a pull request already has, so the push
		// forces, leased on the commit the run last pushed there, or on no branch there at all.
		// The lease names that commit rather than the remote-tracking ref, which any fetch in the
		// repository moves: a commit someone else pushed is refused, never overwritten. Only the
		// run's own branch is pushed.
		const ref = `refs/heads/${branch}`;
		const tip = await revParse(git, dir, ref);
		if (!tip.ok) return err(notLanded(tip.error.message, keep));
		if (stopping(ctx))
			return err(
				notLanded(
					`the run was stopped before the push${rebased ? `; ${await putBack(ctx, dir, rebased.from)}` : ""}`,
					keep,
				),
			);
		const pushed = await git(dir, [
			"push",
			"-q",
			`--force-with-lease=${ref}:${ctx.run.pushed ?? ""}`,
			remote,
			`${ref}:${ref}`,
		]);
		if (!pushed.ok)
			return err(
				notLanded(
					`${pushed.error.message}${ctx.run.pushed ? ` (the run last pushed ${short(ctx.run.pushed)} there)` : ""}`,
					keep,
				),
			);
		// Pushed, the rebased branch is the one the remote has: nothing is left to put back.
		RunState.save(ctx, {
			...ctx.run,
			pushed: tip.value,
			landingFrom: undefined,
		});
		if (stopping(ctx))
			return err(
				notLanded(
					`the run was stopped once branch ${branch} was pushed, before a pull request was opened`,
					keep,
				),
			);
		const open = await openPr(run, dir, branch);
		if (open !== undefined) return ok(open);
		// A stop that came while gh looked the pull request up opens none.
		if (stopping(ctx))
			return err(
				notLanded(
					`the run was stopped once branch ${branch} was pushed, before a pull request was opened`,
					keep,
				),
			);
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

	// Whether a landing that did not land left the branch as the run left it: on its branch, at
	// the tip it was at before the landing rebased it.
	const putBackAt = async (ctx: Ctx, tip: string): Promise<boolean> => {
		const dir = ctx.run.worktree;
		if (dir === undefined) return true;
		const git = ctx.deps.git ?? Worktree.git;
		const on = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
		const at = await revParse(git, dir, "HEAD");
		return (
			on.ok &&
			on.value.trim() === RunStore.branchOf(ctx.run) &&
			at.ok &&
			at.value === tip
		);
	};

	/**
	 * Record what the landing did. The tip it started from is dropped once the branch is landed, or
	 * is back at that tip; a branch left anywhere else keeps it, for `recover` to put back.
	 */
	const record = async (
		ctx: Ctx,
		outcome: Outcome,
		pr?: string,
	): Promise<RunStore.Landing> => {
		const landing: RunStore.Landing = {
			at: ctx.now().toISOString(),
			...outcome,
			summary: Exec.redact(outcome.summary),
		};
		const from = ctx.run.landingFrom;
		const settled =
			from === undefined || outcome.ok || (await putBackAt(ctx, from));
		RunState.save(ctx, {
			...ctx.run,
			landing,
			...(settled ? { landingFrom: undefined } : {}),
			...(pr ? { pr } : {}),
		});
		RunState.event(ctx, {
			type: landing.ok ? "landed" : "warning",
			summary: landing.summary,
			...(pr ? { data: { pr } } : {}),
		});
		return landing;
	};

	/**
	 * Put back a landing a runner died in: abort a rebase it left stopped, and reset the run's
	 * branch to the tip it was at before the landing, so nothing (a gate pass, a checkpoint, a
	 * session) works on a half-replayed tree. Nothing to do when no landing was under way.
	 */
	export const recover = async (ctx: Ctx): Promise<Result<void>> => {
		const tip = ctx.run.landingFrom;
		const dir = ctx.run.worktree;
		if (tip === undefined || dir === undefined) return ok(undefined);
		const branch = RunStore.branchOf(ctx.run);
		const restored = await Worktree.restore(dir, branch, tip, ctx.deps.git);
		if (!restored.ok) {
			// landingFrom stays: nothing goes on in the worktree until it is put back.
			const why = `the landing an earlier runner died in could not be undone (${restored.error.message}): put branch ${branch} in ${dir} back at ${short(tip)} by hand, removing a lock file git left there if it says so`;
			RunState.event(ctx, { type: "warning", summary: why });
			return err(new Error(why));
		}
		RunState.save(ctx, { ...ctx.run, landingFrom: undefined });
		RunState.event(ctx, {
			type: "landing_recovered",
			summary: `the landing the last runner died in is undone: branch ${branch} is back at ${short(tip)}`,
		});
		return ok(undefined);
	};

	/**
	 * Land the run's branch: onto its base, pushed, with a pull request open. What happened is
	 * recorded on the run, the pull request's URL with it, and on its trace.
	 */
	export const land = async (
		ctx: Ctx,
		plan: LoopPlan.Plan,
	): Promise<RunStore.Landing> => {
		const undone = await recover(ctx);
		if (!undone.ok) return record(ctx, notLanded(undone.error.message));
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
