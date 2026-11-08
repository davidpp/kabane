// Budget accounting. Pure: the runner feeds it usage and acts on the verdict.
//
// ACP reports context occupancy (`used` of `size` tokens in the window now), not a running token
// count, so the meter shows occupancy and no token budget is enforced. Cost, where a harness
// reports it, is cumulative per harness session, so a claim's latest figure replaces its earlier
// ones. A harness session resumed by a later claim (a gate retry, a runner restart) goes on from
// the total it had, so the claims that share one count its spend once, and the run's spend is the
// sum over harness sessions.
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
		/** Sum of the latest cost of every harness session that reported one in `currency`. */
		amount: number;
		/** Claims whose spend is unknown: no cost reported, or in another currency. */
		unpriced: number;
	};

	/** The harness session each claim's core session ran in, in claim order. */
	type Sessions = readonly { sessionId: string; acpSessionId?: string }[];

	/**
	 * What the run has spent. A core session no claim names, or one whose claim recorded no
	 * harness session, is a harness session of its own. Within one harness session, each claim
	 * adds what the total grew by since the claim before it; a total lower than the one before
	 * can only be a count the harness started again, and adds whole.
	 */
	export const spent = (
		meter: Meter,
		currency: string,
		sessions: Sessions,
	): Spend => {
		const harness = new Map(
			sessions.map((s) => [s.sessionId, s.acpSessionId ?? s.sessionId]),
		);
		const ordered = [
			...new Set([...harness.keys(), ...Object.keys(meter)]),
		].filter((id) => meter[id] !== undefined);
		const last = new Map<string, number>();
		let amount = 0;
		let unpriced = 0;
		for (const sessionId of ordered) {
			const usage = meter[sessionId];
			if (!usage?.cost || usage.cost.currency !== currency) {
				unpriced += 1;
				continue;
			}
			const key = harness.get(sessionId) ?? sessionId;
			const before = last.get(key) ?? 0;
			const total = usage.cost.amount;
			amount += total >= before ? total - before : total;
			last.set(key, total);
		}
		return { amount, unpriced };
	};

	export type Verdict =
		| { ok: true }
		| { ok: false; reason: "spend"; detail: string };

	/** Whether reported spend has reached the optional spend limit. */
	export const check = (
		budget: LoopConfig.Config["budget"],
		meter: Meter,
		sessions: Sessions,
	): Verdict => {
		if (budget.spend !== undefined) {
			const { amount } = spent(meter, budget.currency, sessions);
			if (amount >= budget.spend)
				return {
					ok: false,
					reason: "spend",
					detail: `${amount.toFixed(2)} ${budget.currency} spent of ${budget.spend} ${budget.currency}`,
				};
		}
		return { ok: true };
	};

	/** Free session slots under the concurrency cap (`RunStore.concurrency`). */
	export const slots = (concurrency: number, live: number): number =>
		Math.max(0, concurrency - live);

	/** Whether one more continuation nudge fits the run's budget. */
	export const canContinue = (
		budget: LoopConfig.Config["budget"],
		used: number,
	): boolean => used < budget.continuations;

	/** Context occupancy as a fraction, for the meter; 0 when the harness gave no window size. */
	export const occupancy = (usage: Usage): number =>
		usage.size > 0 ? usage.used / usage.size : 0;
}
