// The loop tab's header: what the board draws above a run's stream, in place of its one-line title.
// Three rows, in order of what matters: the run's state, its steps as a strip, its budgets as
// meters. `e` adds the sessions and the plan. It shows only what the run has: the implement step,
// the gates and the lenses (with what they found) when it has some, the fixer once it has
// started, spend where a
// harness priced its work, context occupancy (ACP reports occupancy, not a running token count)
// and continuations.
//
// The board polls these lines and maps tones and session series onto its own theme.
import type { Header, HeaderPart, PanelPart } from "@cabane/board/ports";
import { ok } from "@cabane/core";
import { Budget } from "./budget";
import { Loop } from "./commands";
import { Fixer } from "./fixer";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Stop } from "./stop";
import { RunStore } from "./store";

export namespace LoopHeader {
	const METER_CELLS = 10;
	type Part = PanelPart;

	// A claim left open by a runner that died holds no slot: nobody is working it.
	const liveClaims = (run: RunStore.Run): RunStore.Claim[] =>
		RunStore.isLive(run.status)
			? run.claims.filter((claim) => claim.endedAt === undefined)
			: [];

	const exitText = (run: RunStore.Run): string =>
		run.exit
			? `${run.exit.reason}${run.exit.detail ? ` (${run.exit.detail})` : ""}`
			: run.status;

	const word = (count: number, noun: string, many = `${noun}s`): string =>
		count === 1 ? noun : many;

	const busy = (text: string): Part => ({
		text: `● ${text}`,
		tone: "working",
		bold: true,
	});

	// Whether a run past its subtasks and its reviews is landing next: the step the runner takes
	// once the gates are green, every lens has reviewed, the fixer has had what they found, and
	// every recheck it owes is done.
	const landingNext = (
		run: RunStore.Run,
		plan: LoopPlan.Plan,
		now: Date,
	): boolean => {
		if (run.config.land !== "pr" || run.gateRuns.at(-1)?.ok !== true)
			return false;
		const fixer = Fixer.status(run.claims);
		const fixable = LoopPlan.fixable(plan, now, new Set(run.steering.skipped));
		return (
			Lenses.finished(Lenses.status(run.config.lenses, run.claims)) &&
			(fixer.kind === "ended" ||
				(fixer.kind === "unstarted" && fixable.length === 0)) &&
			Lenses.finished(Lenses.rechecks(run.config, run.claims, plan))
		);
	};

	/**
	 * What a running run does once no subtask is being worked, from what run.json holds: landing,
	 * a gate pass, a lens review, the fixer, a recheck, or the step between two of them. Undefined
	 * while a subtask's session is open, and while the plan has open work.
	 */
	const closing = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
	): Part | undefined => {
		const live = liveClaims(run);
		if (live.some((claim) => !RunStore.reviews(claim))) return undefined;
		if (run.landingFrom !== undefined) return busy("landing");
		const gating = run.gating ?? [];
		if (gating.length > 0)
			return busy(`closing gates for ${gating.join(", ")}`);
		const lenses = live.flatMap((claim) => claim.lenses ?? []);
		if (lenses.length > 0)
			return busy(
				`${lenses.join(", ")} ${word(lenses.length, "lens", "lenses")} reviewing`,
			);
		const fixer = live.find((claim) => claim.fixer === true);
		if (fixer) {
			const count = fixer.findings?.length ?? 0;
			return busy(`fixer on ${count} ${word(count, "finding")}`);
		}
		const rechecks = live.flatMap((claim) => claim.recheck ?? []);
		if (rechecks.length > 0)
			return busy(
				`${rechecks.join(", ")} ${word(rechecks.length, "lens", "lenses")} rechecking the fixer's diff`,
			);
		if (!plan || !Stop.workDone(plan)) return undefined;
		return busy(
			landingNext(run, plan, now) ? "landing" : `closing ${run.parentShortId}`,
		);
	};

	/** The one fact that matters most right now, with its glyph and tone. */
	export const state = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
	): Part => {
		switch (run.status) {
			case "completed":
				return { text: "✓ plan done", tone: "done", bold: true };
			case "stopped":
				return {
					text: `⏹ stopped · ${exitText(run)}`,
					tone: "muted",
					bold: true,
				};
			case "failed":
				return {
					text: `✗ ${exitText(run)}${Loop.died(run) ? " · r restarts" : ""}`,
					tone: "failed",
					bold: true,
				};
			case "pending":
				return { text: "○ starting", tone: "muted", bold: true };
			case "running":
				break;
		}
		const live = new Set(liveClaims(run).map((claim) => claim.taskId));
		if (run.steering.paused)
			return {
				text: `⏸ paused · ${live.size} session${live.size === 1 ? "" : "s"} finishing · p resumes`,
				tone: "accent",
				bold: true,
			};
		const wrapping = closing(run, plan, now);
		if (wrapping) return wrapping;
		const health: LoopPlan.Health = plan
			? LoopPlan.health(plan, live, now, new Set(run.steering.skipped))
			: { kind: "moving" };
		if (health.kind === "deadlocked")
			return {
				text: `! deadlocked · ${health.cycle.join(" → ")}`,
				tone: "failed",
				bold: true,
			};
		if (health.kind === "waiting") {
			// Work a human parked holds the run until a human hands it back or closes it: the run
			// never overrules them, and skipping it would leave it open, still holding the plan.
			const parked = LoopPlan.parkedOnly(health.on);
			const it = health.on.length === 1 ? "it" : "them";
			return {
				text: `⏸ waiting on ${health.on.map(LoopPlan.holder).join(", ") || "nothing claimable"}${parked ? ` · set ${it} to next or close ${it}` : ""}`,
				tone: parked ? "accent" : "muted",
				bold: true,
			};
		}
		const unchanged = run.stall?.unchanged ?? 0;
		return unchanged > 0
			? {
					text: `● no progress across ${unchanged} of ${run.config.stallAfter} attempts`,
					tone: "accent",
					bold: true,
				}
			: { text: "● running", tone: "done", bold: true };
	};

	// The gates' step: a pass under way, by what it is for, or else the last pass, by gate. Green
	// ones are checked; the first red one is named.
	const gateStep = (run: RunStore.Run): Part[] => {
		const names = Object.keys(run.config.gates);
		if (names.length === 0) return [];
		const checkpoints = RunStore.checkpoints(run).length;
		const counted =
			checkpoints > 0
				? ` · ${checkpoints} ${word(checkpoints, "checkpoint")}`
				: "";
		const gating = RunStore.isLive(run.status) ? (run.gating ?? []) : [];
		if (gating.length > 0)
			return [
				{ text: "  ›  ", tone: "faint" },
				{ text: "◐ ", tone: "working" },
				{ text: "gates", tone: "default", bold: true },
				{
					text: ` running for ${gating.join(", ")}${counted}`,
					tone: "muted",
				},
			];
		const last = run.gateRuns.at(-1);
		const failed = last?.results.find((r) => !r.ok);
		const glyph: Part = !last
			? { text: "○ ", tone: "muted" }
			: last.ok
				? { text: "✓ ", tone: "done" }
				: { text: "✗ ", tone: "failed" };
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "gates", tone: "default", bold: failed !== undefined },
			{
				text: ` ${failed ? `${failed.name} red` : names.join("·")}${counted}`,
				tone: failed ? "failed" : "muted",
			},
		];
	};

	// Where the lenses stand, in their review or their recheck.
	const lensGlyph = (status: Lenses.Status): Part =>
		status.failed.length > 0
			? { text: "✗ ", tone: "failed" }
			: status.running.length > 0
				? { text: "● ", tone: "working" }
				: Lenses.finished(status)
					? { text: "✓ ", tone: "done" }
					: { text: "○ ", tone: "muted" };

	// The lenses' step, and the debrief's count of what they filed: findings, and how many are
	// still open.
	const lensStep = (run: RunStore.Run, plan: LoopPlan.Plan | null): Part[] => {
		const { lenses } = run.config;
		if (lenses.length === 0) return [];
		const status = Lenses.status(lenses, run.claims);
		const glyph = lensGlyph(status);
		const found = plan ? LoopPlan.findings(plan) : undefined;
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "lenses", tone: "default", bold: status.running.length > 0 },
			{ text: ` ${lenses.join("·")}`, tone: "muted" },
			...(found && found.total > 0
				? [
						{
							text: ` · ${found.total} finding${found.total === 1 ? "" : "s"}`,
							tone: "muted" as const,
						},
						...(found.open > 0
							? [{ text: ` · ${found.open} open`, tone: "accent" as const }]
							: []),
					]
				: []),
		];
	};

	// The fixer's step, once it has a session: its state and how many findings are closed.
	const fixerStep = (run: RunStore.Run, plan: LoopPlan.Plan | null): Part[] => {
		if (!run.claims.some((claim) => claim.fixer === true)) return [];
		const status = Fixer.status(run.claims);
		const glyph: Part =
			status.kind === "failed"
				? { text: "✗ ", tone: "failed" }
				: status.kind === "running"
					? { text: "● ", tone: "working" }
					: status.kind === "ended"
						? { text: "✓ ", tone: "done" }
						: { text: "○ ", tone: "muted" };
		const found = plan ? LoopPlan.findings(plan) : undefined;
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "fixer", tone: "default", bold: status.kind === "running" },
			...(found
				? [
						{
							text: ` ${found.total - found.open}/${found.total} closed`,
							tone: "muted" as const,
						},
					]
				: []),
		];
	};

	// The lenses' recheck of the fixer's diff, once one has a session: how many have rechecked.
	const recheckStep = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
	): Part[] => {
		if (!plan || !run.claims.some((claim) => claim.recheck !== undefined))
			return [];
		const status = Lenses.rechecks(run.config, run.claims, plan);
		const glyph = lensGlyph(status);
		const all = [
			...status.pending,
			...status.running,
			...status.done,
			...status.failed.map((f) => f.name),
		];
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "recheck", tone: "default", bold: status.running.length > 0 },
			{ text: ` ${all.join("·")}`, tone: "muted" },
		];
	};

	/**
	 * The steps the run has, as a strip: implement, then its gates and its lenses when it has some,
	 * then the fixer once it has started, and the recheck of its diff once that has.
	 */
	export const steps = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
	): Part[] => {
		const implementing = run.claims.filter((claim) => !RunStore.reviews(claim));
		const working = implementing.some((claim) => claim.endedAt === undefined);
		const glyph =
			run.status === "completed"
				? { text: "✓ ", tone: "done" as const }
				: run.status === "failed"
					? { text: "✗ ", tone: "failed" as const }
					: working
						? { text: "● ", tone: "working" as const }
						: { text: "○ ", tone: "muted" as const };
		return [
			glyph,
			{ text: "implement", tone: "default", bold: working },
			{
				text: ` ×${implementing.length} session${implementing.length === 1 ? "" : "s"}`,
				tone: "muted",
			},
			...gateStep(run),
			...lensStep(run, plan),
			...fixerStep(run, plan),
			...recheckStep(run, plan),
		];
	};

	type Meter = { label: string; share: number; text: string };

	/** Each budget the run is held to, and the context its sessions fill, as a share of its limit. */
	export const meters = (run: RunStore.Run): Meter[] => {
		const { budget } = run.config;
		const spend = Budget.spent(run.usage, budget.currency, run.claims);
		const live = liveClaims(run).map((claim) => run.usage[claim.sessionId]);
		const shown = (live.length > 0 ? live : Object.values(run.usage)).flatMap(
			(usage) => (usage ? [Budget.occupancy(usage)] : []),
		);
		const context = Math.max(0, ...shown);
		return [
			...(budget.spend !== undefined
				? [
						{
							label: "spend",
							share: spend.amount / budget.spend,
							text: `${spend.amount.toFixed(2)}/${budget.spend} ${budget.currency}`,
						},
					]
				: []),
			{
				label: "context",
				share: context,
				text: `${Math.round(context * 100)}%`,
			},
			{
				label: "continuations",
				share:
					budget.continuations > 0
						? run.continuationsUsed / budget.continuations
						: 0,
				text: `${run.continuationsUsed}/${budget.continuations}`,
			},
		];
	};

	/** `▰▰▰▱▱▱▱▱▱▱`: a share of ten cells, one at least once anything is used. */
	export const cells = (share: number): { filled: number; empty: number } => {
		const clamped = Math.min(1, Math.max(0, share));
		const filled = Math.max(
			clamped > 0 ? 1 : 0,
			Math.round(clamped * METER_CELLS),
		);
		return { filled, empty: METER_CELLS - filled };
	};

	const meterRow = (run: RunStore.Run): HeaderPart[] =>
		meters(run).flatMap((meter, at) => {
			const { filled, empty } = cells(meter.share);
			return [
				{ text: `${at > 0 ? "   " : ""}${meter.label} `, tone: "muted" },
				{
					text: "▰".repeat(filled),
					tone: meter.share >= 0.8 ? "accent" : "working",
				},
				{ text: "▱".repeat(empty), tone: "faint" },
				{ text: ` ${meter.text}`, tone: "secondary" },
			];
		});

	const sessions = (run: RunStore.Run): HeaderPart[][] => {
		const width = Math.max(0, ...run.claims.map((claim) => claim.lane.length));
		return [
			[
				{ text: "sessions", bold: true },
				{
					text: `  ${liveClaims(run).length}/${RunStore.concurrency(run)} slots in use`,
					tone: "muted",
				},
			],
			...run.claims.map((claim, index): HeaderPart[] => [
				{ text: ` ${claim.lane.padEnd(width)}  `, series: index },
				claim.endedAt
					? {
							text: `${claim.outcome ?? "ended"}${claim.detail ? ` · ${claim.detail}` : ""}`,
							tone: "muted",
						}
					: { text: `→ ${claim.shortId}`, tone: "working" },
			]),
		];
	};

	const planRows = (plan: LoopPlan.Plan, run: RunStore.Run): HeaderPart[][] => [
		[{ text: "plan", bold: true }],
		...plan.nodes.map((node): HeaderPart[] => {
			const glyph: PanelPart = LoopPlan.isClosed(node.task)
				? { text: "✓", tone: "done" }
				: node.task.state === "in_progress"
					? { text: "●", tone: "working" }
					: node.task.state === "waiting" || node.task.state === "someday"
						? { text: "⏸", tone: "muted" }
						: { text: "○", tone: "faint" };
			const last = run.claims
				.flatMap((claim, index) =>
					claim.taskId === node.task.id ? [index] : [],
				)
				.at(-1);
			return [
				{ ...glyph, text: ` ${glyph.text} ` },
				{ text: `${node.task.shortId ?? ""}  `, tone: "muted" },
				{
					text: node.task.title,
					tone: LoopPlan.isClosed(node.task) ? "secondary" : "default",
				},
				...(last === undefined
					? []
					: [{ text: `  ${run.claims[last]?.lane ?? ""}`, series: last }]),
				...(node.finding
					? [{ text: "  finding", tone: "muted" as const }]
					: []),
			];
		}),
	];

	const doneCount = (plan: LoopPlan.Plan | null): string => {
		if (!plan) return "";
		const work = plan.nodes.filter((node) => !node.finding);
		const done = work.filter((node) => LoopPlan.isClosed(node.task)).length;
		return `   ${done}/${work.length} done`;
	};

	// The first row: the parent, how much of its plan is done, and the run's state. The state is the
	// fact that matters most, so in a narrow pane the parent's title gives way to it.
	const headline = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		room: number,
	): Part[] => {
		const title = plan?.parent.title ?? "";
		const rest: Part[] = [
			{ text: doneCount(plan), tone: "muted" },
			{ text: "   ", tone: "muted" },
			state(run, plan, now),
		];
		const length = (parts: readonly Part[]): number =>
			parts.reduce((sum, part) => sum + part.text.length, 0);
		const full = `${run.parentShortId}  ${title}`;
		const named = full.length + length(rest) <= room ? full : run.parentShortId;
		return [{ text: named, tone: "default", bold: true }, ...rest];
	};

	/** The rows of a run, independent of the client that draws them. */
	export const lines = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		width: number,
		expanded: boolean,
	): HeaderPart[][] => [
		headline(run, plan, now, width),
		[
			...steps(run, plan),
			{
				text: `   ${liveClaims(run).length}/${RunStore.concurrency(run)} slots · ${run.config.implementer}${run.config.model ? ` ${run.config.model}` : ""}`,
				tone: "muted",
			},
		],
		meterRow(run),
		...(expanded ? sessions(run) : []),
		...(expanded && plan ? planRows(plan, run) : []),
	];

	/** The header for loop cards, reading each run and its current plan on every call. */
	export const make =
		(home: string, basePath: string): Header =>
		async (card, view) => {
			const run = RunStore.read(home, card.id);
			if (!run.ok) return run;
			const plan = await LoopPlan.load(basePath, run.value.parentId);
			return ok(
				lines(
					run.value,
					plan.ok ? plan.value : null,
					new Date(),
					view.width,
					view.expanded,
				),
			);
		};
}
