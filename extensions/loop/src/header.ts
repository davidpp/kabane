import type {
	ActivityStep,
	Header,
	HeaderPart,
	Host,
	PanelPart,
} from "@kabane/extension";
import { ok } from "./result";
// The loop tab's run row: what the board draws above the run's map, in place of its one-line title.
// One row: the parent and its title on the left, and on the right the run's state in words, then
// what it is doing, how many sessions are live, how long it has run and what it has spent. The
// steps themselves are the card's (`RunSteps`), which the board draws as the map. A narrow row gives
// up the title first, then the facts from the least needed.
//
// The board polls this row and maps its tones onto its own theme.

import { Loop } from "./commands";
import { Gates } from "./gates";
import { LoopPlan } from "./plan";
import { RunSteps } from "./steps";
import { RunStore } from "./store";

export namespace LoopHeader {
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

	const busy = (text: string): Part => ({
		text: `● ${text}`,
		tone: "working",
		bold: true,
	});

	// A step is under way when one of its sessions runs, or, for a step with none (the gates, the
	// landing), when it says so: implement between two of its sessions is waiting to claim, not busy.
	const underWay = (step: ActivityStep): boolean =>
		step.state === "running" &&
		(step.sessions === undefined ||
			step.sessions.length === 0 ||
			step.sessions.some((s) => s.state === "running"));

	// What holds a run whose open work nothing can claim. Work a human parked holds it until a human
	// hands it back or closes it: the run never overrules them, and skipping it would leave it open,
	// still holding the plan.
	const held = (on: readonly LoopPlan.Holder[]): Part => {
		const parked = LoopPlan.parkedOnly(on);
		const it = on.length === 1 ? "it" : "them";
		return {
			text: `⏸ waiting on ${on.map(LoopPlan.holder).join(", ") || "nothing claimable"}${parked ? ` · set ${it} to next or close ${it}` : ""}`,
			tone: parked ? "accent" : "muted",
			bold: true,
		};
	};

	// A running run: a question first, then a pause, a stall, the step under way, what holds it,
	// and otherwise the step it is on.
	const running = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		asking: string | undefined,
	): Part => {
		if (asking !== undefined)
			return { text: `? ${asking} waits on you`, tone: "accent", bold: true };
		const live = new Set(liveClaims(run).map((claim) => claim.taskId));
		if (run.steering.paused)
			return {
				text: `⏸ paused · ${live.size} session${live.size === 1 ? "" : "s"} finishing · p resumes`,
				tone: "accent",
				bold: true,
			};
		const unchanged = run.stall?.unchanged ?? 0;
		if (unchanged > 0)
			return {
				text: `● no progress across ${unchanged} of ${run.config.stallAfter} attempts`,
				tone: "accent",
				bold: true,
			};
		const steps = RunSteps.of(run, plan?.nodes ?? null, now);
		const busyStep = steps.findLast(underWay);
		if (busyStep) return busy(busyStep.name);
		const health: LoopPlan.Health = plan
			? LoopPlan.health(plan, live, now, new Set(run.steering.skipped))
			: { kind: "moving" };
		if (health.kind === "deadlocked")
			return {
				text: `! deadlocked · ${health.cycle.join(" → ")}`,
				tone: "failed",
				bold: true,
			};
		// Work still open that nothing can claim holds the run; with none open, it is between steps.
		const open = plan?.nodes.some(
			(n) => LoopPlan.isWork(n) && !LoopPlan.isClosed(n.task),
		);
		if (health.kind === "waiting" && open) return held(health.on);
		return busy(RunSteps.current(steps)?.name ?? "running");
	};

	/** The one fact that matters most right now, with its glyph and tone. */
	export const state = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		asking?: string,
	): Part => {
		switch (run.status) {
			case "completed":
				return { text: "✓ completed", tone: "done", bold: true };
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
				return running(run, plan, now, asking);
		}
	};

	const took = (run: RunStore.Run, now: Date): string =>
		Gates.took(
			Math.max(
				0,
				Date.parse(run.endedAt ?? now.toISOString()) -
					Date.parse(run.startedAt ?? run.createdAt),
			),
		).replace(/^\d+ms$/, "0s");

	// The facts after the state, most needed first: what the step under way has done, the sessions
	// live, what is left for the human, the time, the spend and the continuations used.
	const facts = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		asking: boolean,
	): string[] => {
		const steps = RunSteps.of(run, plan?.nodes ?? null, now);
		const step = RunStore.isLive(run.status)
			? RunSteps.current(steps)
			: undefined;
		const progress = step?.result?.split(" · ")[0];
		const live = liveClaims(run).length;
		const slots = RunStore.concurrency(run);
		const left = RunSteps.left(run, plan?.nodes ?? null).filter(
			(item) => item.taskId !== undefined,
		).length;
		const spend = RunSteps.spend(run);
		const { continuations } = run.config.budget;
		return [
			...(step && progress
				? [asking ? `${step.name} ${progress}` : progress]
				: []),
			...(live > 0
				? [
						live >= slots && slots > 1
							? `${live}/${slots} live`
							: `${live} live`,
					]
				: []),
			// Over, what it left for the human matters more than how long it took.
			...(left > 0
				? [`${left} finding${left === 1 ? "" : "s"} left for you|${left} left`]
				: []),
			took(run, now),
			...(spend > 0 ? [RunSteps.money(run, spend)] : []),
			...(run.continuationsUsed > 0
				? [`${run.continuationsUsed}/${continuations} continuations`]
				: []),
		];
	};

	// The facts the row keeps at `room`: whole ones, from the first, as many as fit.
	// A fact may have a short form after `|`, which a row too narrow for the long one takes.
	const fitting = (all: readonly string[], room: number): string => {
		let text = "";
		for (const fact of all) {
			const [long = fact, short] = fact.split("|");
			const next = [long, short]
				.filter((form) => form !== undefined)
				.map((form) => `${text} · ${form}`)
				.find((line) => line.length <= room);
			if (next === undefined) break;
			text = next;
		}
		return text;
	};

	/** The run row, independent of the client that draws it, at most `width` columns. */
	export const lines = (
		run: RunStore.Run,
		plan: LoopPlan.Plan | null,
		now: Date,
		width: number,
		asking?: string,
	): HeaderPart[][] => {
		const named = state(run, plan, now, asking);
		const id = run.parentShortId;
		const room = Math.max(0, width - id.length - 2 - named.text.length);
		const rest = fitting(facts(run, plan, now, asking !== undefined), room);
		const right = named.text.length + rest.length;
		const title = plan?.parent.title ?? "";
		const titleRoom = width - id.length - 4 - right;
		const shown =
			title === "" || titleRoom < 8
				? ""
				: title.length <= titleRoom
					? title
					: `${title.slice(0, titleRoom - 1)}…`;
		const pad = Math.max(2, width - id.length - 2 - shown.length - right);
		return [
			[
				{ text: id, tone: "default", bold: true },
				...(shown ? [{ text: `  ${shown}`, tone: "secondary" as const }] : []),
				{ text: " ".repeat(pad), tone: "muted" },
				named,
				...(rest ? [{ text: rest, tone: "muted" as const }] : []),
			],
		];
	};

	/**
	 * The header for loop cards, reading each run, its current plan and the questions its sessions
	 * wait on, on every call. The session that asked first is the one the row names.
	 */
	export const make =
		(home: string, record: Host.Record): Header =>
		async (card, view) => {
			const run = RunStore.read(home, card.id);
			if (!run.ok) return run;
			const plan = await LoopPlan.load(record, run.value.parentId);
			const asked = RunStore.isLive(run.value.status)
				? RunStore.pendingQuestions(home, run.value)
				: ok([]);
			const asking = asked.ok ? asked.value[0]?.claim.lane : undefined;
			return ok(
				lines(
					run.value,
					plan.ok ? plan.value : null,
					new Date(),
					view.width,
					asking,
				),
			);
		};
}
