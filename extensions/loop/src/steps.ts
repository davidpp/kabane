// A run as the steps it goes through, for the board's map: implement, the gates, triage, the
// lenses' review, the fixer, the rechecks of its diff and the landing, each with where it stands, a
// line of result and its time, and the sessions it ran. Steps still to come are listed, so the map
// shows what is next. Read off run.json and the parent's children; nothing here is stored.
//
// Steps are not strictly sequential: a subtask filed during the review is claimed while the fixer
// works, so implement can be live again after it was done, beside another step.
import type { Task } from "@kabane/core";
import type {
	ActivityLeft,
	ActivitySession,
	ActivityStep,
	ActivityStepState,
} from "@kabane/extension";
import { Budget } from "./budget";
import { Fixer } from "./fixer";
import { Gates } from "./gates";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Review } from "./review";
import { RunStore } from "./store";

export namespace RunSteps {
	type Nodes = readonly LoopPlan.Node[];

	const plural = (count: number, noun: string, many = `${noun}s`): string =>
		`${count} ${count === 1 ? noun : many}`;

	const ms = (from: string, to: string): number =>
		Math.max(0, Date.parse(to) - Date.parse(from));

	// A session that ended on its own is done; one that errored failed; one cancelled, interrupted
	// or left open by a run that is over stopped. An `incomplete` fixer has had its pass; any other
	// incomplete session did not finish its work.
	const claimState = (
		run: RunStore.Run,
		claim: RunStore.Claim,
	): ActivityStepState => {
		if (claim.endedAt === undefined)
			return RunStore.isLive(run.status) ? "running" : "stopped";
		switch (claim.outcome) {
			case "done":
			case undefined:
				return "done";
			case "incomplete":
				return claim.fixer === true ? "done" : "stopped";
			case "error":
				return "failed";
			case "cancelled":
			case "interrupted":
				return "stopped";
		}
	};

	// Running sessions carry when they started, for the client to count; the others how long they took.
	const timeOf = (
		run: RunStore.Run,
		claim: RunStore.Claim,
		now: Date,
	): { startedAt?: string; durationMs?: number } => {
		if (claim.endedAt !== undefined)
			return { durationMs: ms(claim.startedAt, claim.endedAt) };
		if (RunStore.isLive(run.status)) return { startedAt: claim.startedAt };
		return {
			durationMs: ms(claim.startedAt, run.endedAt ?? now.toISOString()),
		};
	};

	const session = (
		run: RunStore.Run,
		claim: RunStore.Claim,
		name: string,
		result: string | undefined,
		now: Date,
	): ActivitySession => {
		const state = claimState(run, claim);
		const why =
			state === "failed" || state === "stopped"
				? [
						claim.outcome ?? (claim.endedAt ? "ended" : "ended with the run"),
						claim.detail,
					]
						.filter(Boolean)
						.join(": ")
				: undefined;
		const said = why ?? result;
		return {
			name,
			state,
			lane: claim.lane,
			...(said ? { result: said } : {}),
			...timeOf(run, claim, now),
		};
	};

	// A step's time: the span of its sessions, counted by the client while one runs.
	const spanOf = (
		sessions: readonly ActivitySession[],
		claims: readonly RunStore.Claim[],
		run: RunStore.Run,
		now: Date,
	): { startedAt?: string; durationMs?: number } => {
		if (claims.length === 0) return {};
		const start = claims
			.map((c) => c.startedAt)
			.reduce((a, b) => (a < b ? a : b));
		if (sessions.some((s) => s.state === "running"))
			return { startedAt: start };
		const end = claims
			.map((c) => c.endedAt ?? run.endedAt ?? now.toISOString())
			.reduce((a, b) => (a > b ? a : b));
		return { durationMs: ms(start, end) };
	};

	// The step's own state from its sessions': one running makes it running, then a failure, then
	// done once each has ended, else pending.
	const stateOf = (sessions: readonly ActivitySession[]): ActivityStepState => {
		if (sessions.some((s) => s.state === "running")) return "running";
		if (sessions.some((s) => s.state === "failed")) return "failed";
		if (sessions.length > 0 && sessions.every((s) => s.state !== "pending"))
			return sessions.some((s) => s.state === "stopped") ? "stopped" : "done";
		return "pending";
	};

	const findingsOf = (nodes: Nodes): Task[] =>
		nodes.filter((n) => n.finding).map((n) => n.task);

	const live = (sessions: readonly ActivitySession[]): number =>
		sessions.filter((s) => s.state === "running").length;

	const progress = (
		sessions: readonly ActivitySession[],
		total: number,
	): string => {
		const done = sessions.filter(
			(s) => s.state !== "pending" && s.state !== "running",
		).length;
		const running = live(sessions);
		return [
			`${done} of ${total} done`,
			...(running > 0 ? [`${running} live`] : []),
		].join(" · ");
	};

	const implement = (
		run: RunStore.Run,
		nodes: Nodes | null,
		now: Date,
	): ActivityStep => {
		const claims = run.claims.filter((c) => !RunStore.reviews(c));
		const titles = new Map(nodes?.map((n) => [n.task.id, n.task.title]));
		const sessions = claims.map((c) =>
			session(run, c, c.lane, titles.get(c.taskId), now),
		);
		const work = nodes?.filter(LoopPlan.isWork) ?? [];
		const open = work.filter((n) => !LoopPlan.isClosed(n.task)).length;
		const running = live(sessions);
		// With work still open, implement is the step under way between its sessions; once the run is
		// over it stopped there.
		const state: ActivityStepState =
			running > 0
				? "running"
				: work.length === 0
					? claims.length > 0
						? stateOf(sessions)
						: "pending"
					: open === 0
						? "done"
						: RunStore.isLive(run.status)
							? claims.length > 0
								? "running"
								: "pending"
							: run.status === "failed"
								? "failed"
								: "stopped";
		const result =
			work.length > 0
				? [
						`${work.length - open} of ${work.length} done`,
						...(running > 0 ? [`${running} live`] : []),
					].join(" · ")
				: claims.length > 0
					? plural(claims.length, "session")
					: undefined;
		return {
			name: "implement",
			state,
			...(result ? { result } : {}),
			...spanOf(sessions, claims, run, now),
			sessions,
		};
	};

	const gates = (run: RunStore.Run): ActivityStep | null => {
		const names = Object.keys(run.config.gates);
		if (names.length === 0) return null;
		const gating = RunStore.isLive(run.status) ? (run.gating ?? []) : [];
		// A pass under way when the run ended (its runner died, or a stop) was never recorded.
		const cut = RunStore.isLive(run.status) ? [] : (run.gating ?? []);
		if (cut.length > 0)
			return {
				name: "gates",
				state: overState(run),
				result: `cut short for ${cut.join(", ")}`,
			};
		// Passes for different subtasks run at once: each subject's latest pass says whether it is
		// green, so one finishing green after another's red does not clear it.
		const latest = new Map(
			run.gateRuns.map((g) => [g.taskId ?? run.parentId, g]),
		);
		const red = [...latest.values()].find((g) => !g.ok);
		const failed = red?.results.find((r) => !r.ok);
		const passes = run.gateRuns.length;
		// The passes' own times, summed: passes overlap and sit between the other steps, so no
		// elapsed time for the step can be read off them.
		const took = run.gateRuns
			.flatMap((g) => g.results)
			.reduce((sum, r) => sum + r.ms, 0);
		const state: ActivityStepState =
			gating.length > 0
				? "running"
				: passes === 0
					? "pending"
					: red
						? "failed"
						: "done";
		const subject = (taskId: string | undefined): string =>
			taskId === undefined || taskId === run.parentId
				? run.parentShortId
				: (run.claims.find((c) => c.taskId === taskId)?.shortId ?? taskId);
		const result =
			gating.length > 0
				? `running for ${gating.join(", ")}`
				: red
					? `${failed?.name ?? "a gate"} red for ${subject(red.taskId)}`
					: [
							names.join("·"),
							...(passes > 0
								? [
										plural(passes, "pass", "passes"),
										`${Gates.took(took)} gate time`,
									]
								: []),
						].join(" · ");
		return { name: "gates", state, result };
	};

	const triage = (run: RunStore.Run, now: Date): ActivityStep | null => {
		const claims = run.claims.filter((c) => c.triage === true);
		if (!Review.wanted(run.config) && claims.length === 0) return null;
		const sessions = claims.map((c) => session(run, c, c.lane, undefined, now));
		const plan = run.review;
		const result = plan
			? [
					plural(plan.groups.length, "review session"),
					...(plan.skipped.length > 0
						? [`${plural(plan.skipped.length, "lens", "lenses")} skipped`]
						: []),
				].join(" · ")
			: undefined;
		return {
			name: "triage",
			// A review plan that is there was decided, by triage or by its fallback.
			state: plan && live(sessions) === 0 ? "done" : stateOf(sessions),
			...(result ? { result } : {}),
			...spanOf(sessions, claims, run, now),
			sessions,
		};
	};

	// The findings created before the first recheck started: what the review filed.
	const filedByReview = (run: RunStore.Run, nodes: Nodes): Task[] => {
		const recheck = run.claims.find((c) => c.recheck !== undefined);
		return findingsOf(nodes).filter(
			(t) => recheck === undefined || t.createdAt < recheck.startedAt,
		);
	};

	const lensOf = (task: Task): string | undefined =>
		LoopPlan.lensOf(task)?.toLowerCase();

	const review = (
		run: RunStore.Run,
		nodes: Nodes | null,
		now: Date,
	): ActivityStep | null => {
		const { config } = run;
		if (config.lenses.length === 0) return null;
		const claims = run.claims.filter((c) => c.lenses !== undefined);
		const filed = nodes ? filedByReview(run, nodes) : [];
		const ran = claims.map((c) => {
			const lenses = c.lenses ?? [];
			const count = filed.filter((t) =>
				lenses.includes(lensOf(t) ?? ""),
			).length;
			return session(
				run,
				c,
				c.lane.replace(/-lens(?=#|$)/, ""),
				nodes && c.endedAt !== undefined
					? `${plural(count, "finding")} filed`
					: undefined,
				now,
			);
		});
		const claimed = new Set(claims.flatMap((c) => c.lenses ?? []));
		const waiting: ActivitySession[] = Review.groups(config, run.review)
			.filter((g) => g.lenses.every((name) => !claimed.has(name)))
			.map((g) => ({ name: g.lenses.join("+"), state: "pending" }));
		// A lens triage skipped counts as reviewed.
		const skipped: ActivitySession[] = (run.review?.skipped ?? []).map((s) => ({
			name: s.lens,
			state: "done",
			result: `skipped · ${s.reason}`,
		}));
		const sessions = [...ran, ...waiting, ...skipped];
		const status = Lenses.status(
			Review.reviewed(config, run.review),
			run.claims,
		);
		const state: ActivityStepState =
			status.running.length > 0
				? underWay(run)
				: status.failed.length > 0
					? "failed"
					: Lenses.finished(status)
						? "done"
						: claims.length > 0 && !RunStore.isLive(run.status)
							? "stopped"
							: "pending";
		const result =
			state === "running"
				? progress(ran, Review.groups(config, run.review).length)
				: nodes && claims.length > 0
					? `${plural(filed.length, "finding")} filed`
					: undefined;
		return {
			name: "review",
			state,
			...(result ? { result } : {}),
			...spanOf(ran, claims, run, now),
			sessions,
		};
	};

	// What the fixer settled of `ids`: the ones closed now, and the ones a recheck was given, which
	// it closed to make them due even when the recheck reopened them since.
	const settledOf = (
		ids: readonly string[],
		nodes: Nodes,
		run: RunStore.Run,
	): number => {
		const settled = new Set([
			...nodes.filter((n) => LoopPlan.isClosed(n.task)).map((n) => n.task.id),
			...run.claims.flatMap((c) =>
				c.recheck === undefined ? [] : (c.findings ?? []),
			),
		]);
		return ids.filter((id) => settled.has(id)).length;
	};

	const fixer = (
		run: RunStore.Run,
		nodes: Nodes | null,
		now: Date,
	): ActivityStep | null => {
		if (run.config.lenses.length === 0) return null;
		const claims = run.claims.filter((c) => c.fixer === true);
		const sessions = claims.map((c) => {
			const given = c.findings ?? [];
			return session(
				run,
				c,
				c.lane,
				nodes
					? `${settledOf(given, nodes, run)} of ${given.length} settled`
					: undefined,
				now,
			);
		});
		const status = Fixer.status(run.claims);
		const given = claims.at(-1)?.findings ?? [];
		if (claims.length === 0)
			return run.status === "completed"
				? { name: "fixer", state: "done", result: "nothing to fix" }
				: { name: "fixer", state: "pending" };
		const state: ActivityStepState =
			status.kind === "running"
				? underWay(run)
				: status.kind === "ended"
					? "done"
					: status.kind === "failed"
						? "failed"
						: stateOf(sessions);
		const result =
			state === "running"
				? `on ${plural(given.length, "finding")}`
				: nodes
					? `${settledOf(given, nodes, run)} settled`
					: undefined;
		return {
			name: "fixer",
			state,
			...(result ? { result } : {}),
			...spanOf(sessions, claims, run, now),
			sessions,
		};
	};

	const recheck = (
		run: RunStore.Run,
		nodes: Nodes | null,
		fixed: ActivityStep | null,
		now: Date,
	): ActivityStep | null => {
		const { config } = run;
		if (!config.recheck || config.lenses.length === 0) return null;
		const claims = run.claims.filter((c) => c.recheck !== undefined);
		const due = nodes
			? Lenses.rechecking(config, run.claims, { nodes: [...nodes] })
			: new Map<string, Task[]>();
		const open = new Set(
			nodes?.filter((n) => !LoopPlan.isClosed(n.task)).map((n) => n.task.id),
		);
		const findings = nodes ? findingsOf(nodes) : [];
		const counts = (c: RunStore.Claim) => {
			const given = c.findings ?? [];
			const reopened = given.filter((id) => open.has(id)).length;
			const filed = findings.filter(
				(t) =>
					lensOf(t) === c.recheck &&
					t.createdAt >= c.startedAt &&
					!given.includes(t.id),
			).length;
			return { confirmed: given.length - reopened, reopened, filed };
		};
		const said = (c: RunStore.Claim): string | undefined => {
			if (!nodes) return undefined;
			if (c.endedAt === undefined)
				return plural(c.findings?.length ?? 0, "finding");
			const n = counts(c);
			return [
				`${n.confirmed} confirmed`,
				`${n.reopened} reopened`,
				...(n.filed > 0 ? [`${n.filed} filed`] : []),
			].join(" · ");
		};
		const toSession = (c: RunStore.Claim): ActivitySession =>
			session(run, c, c.lane.replace(/-recheck(?=#|$)/, ""), said(c), now);
		// Every attempt is listed, for its log; a lens's latest decides where it stands and what it
		// found, so a retry neither keeps an interrupted attempt's state nor counts twice.
		const ran = claims.map(toSession);
		const latest = [...new Map(claims.map((c) => [c.recheck, c])).values()];
		const claimed = new Set(claims.map((c) => c.recheck));
		const waiting: ActivitySession[] = [...due]
			.filter(([name]) => !claimed.has(name))
			.map(([name, tasks]) => ({
				name,
				state: "pending",
				result: `${plural(tasks.length, "finding")} · waits for a slot`,
			}));
		const sessions = [...ran, ...waiting];
		if (claims.length === 0 && due.size === 0)
			// Over, or with the fixer's pass over and nothing it closed to recheck.
			return run.status === "completed" ||
				(nodes !== null && fixed?.state === "done")
				? { name: "recheck", state: "done", result: "nothing to recheck" }
				: { name: "recheck", state: "pending" };
		const state = stateOf([...latest.map(toSession), ...waiting]);
		const total = latest.reduce(
			(sum, c) => {
				const n = counts(c);
				return {
					confirmed: sum.confirmed + n.confirmed,
					reopened: sum.reopened + n.reopened,
					filed: sum.filed + n.filed,
				};
			},
			{ confirmed: 0, reopened: 0, filed: 0 },
		);
		const result =
			state === "running" || state === "pending"
				? progress(
						[...latest.map(toSession), ...waiting],
						latest.length + waiting.length,
					)
				: nodes
					? [
							`${total.confirmed} confirmed`,
							`${total.reopened} reopened`,
							`${total.filed} filed`,
						].join(" · ")
					: undefined;
		return {
			name: "recheck",
			state,
			...(result ? { result } : {}),
			...spanOf(ran, claims, run, now),
			sessions,
		};
	};

	const LANDING: Readonly<Record<string, string>> = {
		none: "none: the branch stays for review",
		pr: "pr: opens a pull request",
		merge: "merge: merges into the base",
	};

	/**
	 * What became of an over run's branch after the run: `removed` once its worktree and branch are
	 * gone (`kabane loop prune` removes both once the branch merged), which run.json does not record.
	 */
	export type After = { removed?: boolean };

	const land = (run: RunStore.Run, after: After): ActivityStep => {
		const how = run.config.land;
		if (run.landingFrom !== undefined)
			return RunStore.isLive(run.status)
				? { name: "land", state: "running", result: `${how}: landing` }
				: { name: "land", state: overState(run), result: `${how}: cut short` };
		if (run.landing)
			return {
				name: "land",
				state: run.landing.ok ? "done" : "failed",
				result: `${how}: ${run.landing.summary}`,
			};
		if (run.status === "completed" && how === "none")
			return {
				name: "land",
				state: "done",
				result: after.removed
					? "none: kept for review, since merged and removed"
					: "none: kept for review",
			};
		return { name: "land", state: "pending", result: LANDING[how] ?? how };
	};

	/** The run's steps, in the order they run, the ones still to come included. */
	export const of = (
		run: RunStore.Run,
		nodes: Nodes | null,
		now: Date,
		after: After = {},
	): ActivityStep[] => {
		const fixed = fixer(run, nodes, now);
		return [
			implement(run, nodes, now),
			gates(run),
			triage(run, now),
			review(run, nodes, now),
			fixed,
			recheck(run, nodes, fixed, now),
			land(run, after),
		].filter((step): step is ActivityStep => step !== null);
	};

	// How a step under way ends when the run ends under it (its runner died, or a stop): failed with
	// the run, else stopped. `Lenses.status` and `Fixer.status` read a claim the runner never ended
	// as running.
	const overState = (run: RunStore.Run): ActivityStepState =>
		run.status === "failed" ? "failed" : "stopped";

	const underWay = (run: RunStore.Run): ActivityStepState =>
		RunStore.isLive(run.status) ? "running" : overState(run);

	/**
	 * What an over run left for the human: every finding still open, reopened by a recheck or filed
	 * by a lens, then its branch when it did not land and is still there, and its pull request when
	 * it opened one.
	 */
	export const left = (
		run: RunStore.Run,
		nodes: Nodes | null,
		after: After = {},
	): ActivityLeft[] => {
		if (RunStore.isLive(run.status)) return [];
		const reopenedBy = new Map<string, string>();
		for (const c of run.claims)
			if (c.recheck !== undefined)
				for (const id of c.findings ?? []) reopenedBy.set(id, c.recheck);
		const findings: ActivityLeft[] = (nodes ?? [])
			.filter((n) => n.finding && !LoopPlan.isClosed(n.task))
			.map(({ task }) => {
				const by = reopenedBy.get(task.id);
				const lens = lensOf(task);
				return {
					taskId: task.id,
					...(task.shortId ? { taskShortId: task.shortId } : {}),
					how: by
						? `reopened by ${by}`
						: lens
							? `filed by ${lens}`
							: "open finding",
					reason: task.title,
				};
			});
		const branch: ActivityLeft[] =
			run.worktree !== undefined && run.landing?.ok !== true && !after.removed
				? [
						{
							how: `branch ${RunStore.branchOf(run)}`,
							reason: `land: ${run.config.land}${run.landing ? ` · ${run.landing.summary}` : ""}`,
						},
					]
				: [];
		const pr: ActivityLeft[] = run.pr
			? [{ how: `pull request ${run.pr}`, reason: "waits on its review" }]
			: [];
		return [...findings, ...branch, ...pr];
	};

	/** The step the run is on: the last one running, else the first still to come. */
	export const current = (
		steps: readonly ActivityStep[],
	): ActivityStep | undefined =>
		steps.findLast((s) => s.state === "running") ??
		steps.find((s) => s.state === "pending");

	/** What the run has spent where a harness priced its work, in the run's currency. */
	export const spend = (run: RunStore.Run): number =>
		Budget.spent(run.usage, run.config.budget.currency, run.claims).amount;
}
