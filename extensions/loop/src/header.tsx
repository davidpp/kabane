/** @jsxImportSource @opentui/react */
// The loop tab's header: what the board draws above a run's stream, in place of its one-line title.
// Three rows, in order of what matters: the run's state, its steps as a strip, its budgets as
// meters. `e` adds the sessions and the plan. It shows only what the run has: the implement step,
// the gates and the lenses (with what they found) when it has some, wall time, spend where a
// harness priced its work, context occupancy (ACP reports occupancy, not a running token count)
// and continuations.
//
// It reads the board's theme and nothing else of the board's: tones are the theme's roles, and a
// session's color is the theme's series at its claim's place, the same as its lane chip and its
// lines. The run comes from `run.json` and the plan from the tracker, polled while the tab is open.
import {
	type ActivityCard,
	type CardHeader,
	type CardHeaderProps,
	Theme,
	useTheme,
} from "@cabane/board";
import { TextAttributes } from "@opentui/core";
import { type ReactNode, useEffect, useState } from "react";
import { Budget } from "./budget";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { RunStore } from "./store";

export namespace LoopHeader {
	const POLL_MS = 1000;
	const METER_CELLS = 10;

	type Tone =
		| "text"
		| "muted"
		| "faint"
		| "working"
		| "done"
		| "failed"
		| "accent";
	type Part = { text: string; tone: Tone; bold?: boolean };

	type Snapshot = { run: RunStore.Run; plan: LoopPlan.Plan | null };

	const liveClaims = (run: RunStore.Run): RunStore.Claim[] =>
		run.claims.filter((claim) => claim.endedAt === undefined);

	const exitText = (run: RunStore.Run): string =>
		run.exit
			? `${run.exit.reason}${run.exit.detail ? ` (${run.exit.detail})` : ""}`
			: run.status;

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
				return { text: `✗ ${exitText(run)}`, tone: "failed", bold: true };
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
		const health: LoopPlan.Health = plan
			? LoopPlan.health(plan, live, now, new Set(run.steering.skipped))
			: { kind: "moving" };
		if (health.kind === "deadlocked")
			return {
				text: `! deadlocked · ${health.cycle.join(" → ")}`,
				tone: "failed",
				bold: true,
			};
		if (health.kind === "waiting")
			return {
				text: `⏸ waiting on ${health.on.join(", ") || "nothing claimable"}`,
				tone: "muted",
				bold: true,
			};
		const unchanged = run.stall?.unchanged ?? 0;
		return unchanged > 0
			? {
					text: `● no progress across ${unchanged} of ${run.config.stallAfter} attempts`,
					tone: "accent",
					bold: true,
				}
			: { text: "● running", tone: "done", bold: true };
	};

	// The gates' step: the last pass, by gate. Green ones are checked; the first red one is named.
	const gateStep = (run: RunStore.Run): Part[] => {
		const names = Object.keys(run.config.gates);
		if (names.length === 0) return [];
		const last = run.gateRuns.at(-1);
		const failed = last?.results.find((r) => !r.ok);
		const glyph: Part = !last
			? { text: "○ ", tone: "muted" }
			: last.ok
				? { text: "✓ ", tone: "done" }
				: { text: "✗ ", tone: "failed" };
		const checkpoints = RunStore.checkpoints(run).length;
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "gates", tone: "text", bold: failed !== undefined },
			{
				text: ` ${failed ? `${failed.name} red` : names.join("·")}${checkpoints > 0 ? ` · ${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"}` : ""}`,
				tone: failed ? "failed" : "muted",
			},
		];
	};

	// The lenses' step, and the debrief's count of what they filed: findings, and the open `p1`s
	// that keep the run going.
	const lensStep = (run: RunStore.Run, plan: LoopPlan.Plan | null): Part[] => {
		const { lenses } = run.config;
		if (lenses.length === 0) return [];
		const status = Lenses.status(lenses, run.claims);
		const glyph: Part =
			status.failed.length > 0
				? { text: "✗ ", tone: "failed" }
				: status.running.length > 0
					? { text: "● ", tone: "working" }
					: Lenses.finished(status)
						? { text: "✓ ", tone: "done" }
						: { text: "○ ", tone: "muted" };
		const found = plan ? LoopPlan.findings(plan) : undefined;
		return [
			{ text: "  ›  ", tone: "faint" },
			glyph,
			{ text: "lenses", tone: "text", bold: status.running.length > 0 },
			{ text: ` ${lenses.join("·")}`, tone: "muted" },
			...(found && found.total > 0
				? [
						{
							text: ` · ${found.total} finding${found.total === 1 ? "" : "s"}`,
							tone: "muted" as const,
						},
						...(found.openP1 > 0
							? [
									{
										text: ` · ${found.openP1} p1 open`,
										tone: "accent" as const,
									},
								]
							: []),
					]
				: []),
		];
	};

	/** The steps the run has, as a strip: implement, then its gates and its lenses when it has some. */
	export const steps = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
	): Part[] => {
		const implementing = run.claims.filter((claim) => claim.lens === undefined);
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
			{ text: "implement", tone: "text", bold: working },
			{
				text: ` ×${implementing.length} session${implementing.length === 1 ? "" : "s"}`,
				tone: "muted",
			},
			...gateStep(run),
			...lensStep(run, plan),
		];
	};

	type Meter = { label: string; share: number; text: string };

	/** Each budget the run is held to, and the context its sessions fill, as a share of its limit. */
	export const meters = (run: RunStore.Run, now: Date): Meter[] => {
		const { budget } = run.config;
		const elapsed = RunStore.wallMs(run, now) / 60_000;
		const spend = Budget.spent(run.usage, budget.currency);
		const live = liveClaims(run).map((claim) => run.usage[claim.sessionId]);
		const shown = (live.length > 0 ? live : Object.values(run.usage)).flatMap(
			(usage) => (usage ? [Budget.occupancy(usage)] : []),
		);
		const context = Math.max(0, ...shown);
		return [
			{
				label: "time",
				share: elapsed / budget.wallMinutes,
				text: `${Math.round(elapsed)}m/${budget.wallMinutes}m`,
			},
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

	const useSnapshot = (
		home: string,
		basePath: string,
		runId: string,
	): Snapshot | null => {
		const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
		useEffect(() => {
			let cancelled = false;
			const poll = async (): Promise<void> => {
				const run = RunStore.read(home, runId);
				if (!run.ok) return;
				const plan = await LoopPlan.load(basePath, run.value.parentId);
				if (!cancelled)
					setSnapshot({ run: run.value, plan: plan.ok ? plan.value : null });
			};
			void poll();
			const timer = setInterval(() => void poll(), POLL_MS);
			return () => {
				cancelled = true;
				clearInterval(timer);
			};
		}, [home, basePath, runId]);
		return snapshot;
	};

	const Row = ({
		parts,
		bg,
	}: {
		parts: readonly Part[];
		bg: string;
	}): ReactNode => {
		const theme = useTheme();
		return (
			<text bg={bg} wrapMode="none">
				{parts.map((part, at) => (
					// Index keys: a row's parts are positional.
					<span
						key={at}
						fg={theme[part.tone]}
						attributes={part.bold ? TextAttributes.BOLD : 0}
					>
						{part.text}
					</span>
				))}
			</text>
		);
	};

	const MeterRow = ({
		meters: shown,
		bg,
	}: {
		meters: readonly Meter[];
		bg: string;
	}): ReactNode => {
		const theme = useTheme();
		return (
			<text bg={bg} wrapMode="none">
				{shown.map((meter, at) => {
					const { filled, empty } = cells(meter.share);
					// Most of a budget gone is a human's call to make, so it takes the accent.
					const fill = meter.share >= 0.8 ? theme.accent : theme.working;
					return (
						<span key={meter.label}>
							<span
								fg={theme.muted}
							>{`${at > 0 ? "   " : ""}${meter.label} `}</span>
							<span fg={fill}>{"▰".repeat(filled)}</span>
							<span fg={theme.faint}>{"▱".repeat(empty)}</span>
							<span fg={theme.secondary}>{` ${meter.text}`}</span>
						</span>
					);
				})}
			</text>
		);
	};

	const Sessions = ({
		run,
		bg,
	}: {
		run: RunStore.Run;
		bg: string;
	}): ReactNode => {
		const theme = useTheme();
		const width = Math.max(0, ...run.claims.map((claim) => claim.lane.length));
		return (
			<>
				<text bg={bg} fg={theme.text} attributes={TextAttributes.BOLD}>
					sessions
					<span fg={theme.muted} attributes={0}>
						{`  ${liveClaims(run).length}/${run.config.budget.concurrency} slots in use`}
					</span>
				</text>
				{run.claims.map((claim, index) => (
					<text key={claim.sessionId} bg={bg} wrapMode="none">
						<span fg={Theme.seriesOf(theme, index)}>
							{` ${claim.lane.padEnd(width)}  `}
						</span>
						{claim.endedAt ? (
							<span fg={theme.muted}>
								{`${claim.outcome ?? "ended"}${claim.detail ? ` · ${claim.detail}` : ""}`}
							</span>
						) : (
							<span fg={theme.working}>{`→ ${claim.shortId}`}</span>
						)}
					</text>
				))}
			</>
		);
	};

	const PlanRows = ({
		plan,
		run,
		bg,
	}: {
		plan: LoopPlan.Plan;
		run: RunStore.Run;
		bg: string;
	}): ReactNode => {
		const theme = useTheme();
		const glyph = (node: LoopPlan.Node): { text: string; fg: string } =>
			LoopPlan.isClosed(node.task)
				? { text: "✓", fg: theme.done }
				: node.task.state === "in_progress"
					? { text: "●", fg: theme.working }
					: node.task.state === "waiting" || node.task.state === "someday"
						? { text: "⏸", fg: theme.muted }
						: { text: "○", fg: theme.faint };
		return (
			<>
				<text bg={bg} fg={theme.text} attributes={TextAttributes.BOLD}>
					plan
				</text>
				{plan.nodes.map((node) => {
					const g = glyph(node);
					const lanes = run.claims.flatMap((claim, index) =>
						claim.taskId === node.task.id ? [index] : [],
					);
					const last = lanes.at(-1);
					return (
						<text key={node.task.id} bg={bg} wrapMode="none">
							<span fg={g.fg}>{` ${g.text} `}</span>
							<span fg={theme.muted}>{`${node.task.shortId ?? ""}  `}</span>
							<span
								fg={LoopPlan.isClosed(node.task) ? theme.secondary : theme.text}
							>
								{node.task.title}
							</span>
							{last !== undefined ? (
								<span fg={Theme.seriesOf(theme, last)}>
									{`  ${run.claims[last]?.lane ?? ""}`}
								</span>
							) : null}
							{node.finding ? (
								<span fg={theme.muted}>{"  finding"}</span>
							) : null}
						</text>
					);
				})}
			</>
		);
	};

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
		return [{ text: named, tone: "text", bold: true }, ...rest];
	};

	const Header = ({
		home,
		basePath,
		card,
		width,
		expanded,
	}: {
		home: string;
		basePath: string;
		card: ActivityCard;
		width: number;
		expanded: boolean;
	}): ReactNode => {
		const theme = useTheme();
		const snapshot = useSnapshot(home, basePath, card.id);
		const bg = theme.surface.raised;
		if (!snapshot)
			return (
				<text fg={theme.muted} style={{ flexShrink: 0 }}>
					loading…
				</text>
			);
		const { run, plan } = snapshot;
		const now = new Date();
		const live = liveClaims(run).length;
		return (
			<box
				style={{
					flexDirection: "column",
					flexShrink: 0,
					backgroundColor: bg,
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				<Row bg={bg} parts={headline(run, plan, now, width - 2)} />
				<Row
					bg={bg}
					parts={[
						...steps(run, plan),
						{
							text: `   ${live}/${run.config.budget.concurrency} slots · ${run.config.implementer}${run.config.model ? ` ${run.config.model}` : ""}`,
							tone: "muted",
						},
					]}
				/>
				<MeterRow meters={meters(run, now)} bg={bg} />
				{expanded ? <Sessions run={run} bg={bg} /> : null}
				{expanded && plan ? <PlanRows plan={plan} run={run} bg={bg} /> : null}
			</box>
		);
	};

	/** The header for loop cards, reading each run from `home` and its plan from `basePath`. */
	export const make = (home: string, basePath: string): CardHeader => {
		const LoopTabHeader = ({
			card,
			width,
			expanded,
		}: CardHeaderProps): ReactNode => (
			<Header
				home={home}
				basePath={basePath}
				card={card}
				width={width}
				expanded={expanded}
			/>
		);
		return LoopTabHeader;
	};
}
