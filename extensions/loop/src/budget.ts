// Budget accounting. Pure: the runner feeds it usage and the clock and acts on the verdict.
//
// ACP reports context occupancy (`used` of `size` tokens in the window now), not a running token
// count, so the meter shows occupancy and no token budget is enforced. Cost, where a harness
// reports it, is cumulative per session, so a session's latest figure replaces its earlier ones
// and the run's spend is the sum over sessions.
import { z } from "zod";
import type { LoopConfig } from "./config";

export namespace Budget {
	export const UsageSchema = z.object({
		used: z.number().min(0),
		size: z.number().min(0),
		cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
	});
	export type Usage = z.infer<typeof UsageSchema>;

	/** Latest usage per core session id. */
	export const MeterSchema = z.record(UsageSchema);
	export type Meter = z.infer<typeof MeterSchema>;

	/**
	 * A usage update replaces the session's occupancy. A cost replaces the session's cost; an
	 * update without one keeps the last cost seen, since cost is cumulative and never resets.
	 */
	export const record = (
		meter: Meter,
		sessionId: string,
		usage: Usage,
	): Meter => {
		const cost = usage.cost ?? meter[sessionId]?.cost;
		return {
			...meter,
			[sessionId]: {
				used: usage.used,
				size: usage.size,
				...(cost ? { cost } : {}),
			},
		};
	};

	export type Spend = {
		/** Sum of the latest cost of every session that reported one in `currency`. */
		amount: number;
		/** Sessions whose spend is unknown: no cost reported, or in another currency. */
		unpriced: number;
	};

	export const spent = (meter: Meter, currency: string): Spend => {
		let amount = 0;
		let unpriced = 0;
		for (const usage of Object.values(meter)) {
			if (usage.cost && usage.cost.currency === currency)
				amount += usage.cost.amount;
			else unpriced += 1;
		}
		return { amount, unpriced };
	};

	export type Verdict =
		| { ok: true }
		| { ok: false; reason: "wall-time" | "spend"; detail: string };

	export type Clock = { startedAt: string; now: Date };

	/** Whether the run may go on: wall time always, spend once a harness has priced something. */
	export const check = (
		budget: LoopConfig.Config["budget"],
		meter: Meter,
		clock: Clock,
	): Verdict => {
		const elapsedMs = clock.now.getTime() - Date.parse(clock.startedAt);
		const wallMs = budget.wallMinutes * 60_000;
		if (elapsedMs >= wallMs)
			return {
				ok: false,
				reason: "wall-time",
				detail: `${budget.wallMinutes} min wall-time budget reached`,
			};
		if (budget.spend !== undefined) {
			const { amount } = spent(meter, budget.currency);
			if (amount >= budget.spend)
				return {
					ok: false,
					reason: "spend",
					detail: `${amount.toFixed(2)} ${budget.currency} spent of ${budget.spend} ${budget.currency}`,
				};
		}
		return { ok: true };
	};

	/** Free session slots under the concurrency cap. */
	export const slots = (
		budget: LoopConfig.Config["budget"],
		live: number,
	): number => Math.max(0, budget.concurrency - live);

	/** Whether one more continuation nudge fits the run's budget. */
	export const canContinue = (
		budget: LoopConfig.Config["budget"],
		used: number,
	): boolean => used < budget.continuations;

	/** Context occupancy as a fraction, for the meter; 0 when the harness gave no window size. */
	export const occupancy = (usage: Usage): number =>
		usage.size > 0 ? usage.used / usage.size : 0;
}
