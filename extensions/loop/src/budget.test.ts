import { describe, expect, it } from "bun:test";
import { Budget } from "./budget";
import { LoopConfig } from "./config";

const budget = (input: LoopConfig.Input["budget"] = {}) => {
	const parsed = LoopConfig.Schema.safeParse({ budget: input });
	if (!parsed.success) throw parsed.error;
	return parsed.data.budget;
};

const START = "2026-10-10T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000);

describe("Budget.record", () => {
	it("replaces occupancy and keeps a session's last cost when an update has none", () => {
		let meter = Budget.record({}, "s1", {
			used: 10,
			size: 100,
			cost: { amount: 0.5, currency: "USD" },
		});
		meter = Budget.record(meter, "s1", { used: 40, size: 100 });
		expect(meter.s1).toEqual({
			used: 40,
			size: 100,
			cost: { amount: 0.5, currency: "USD" },
		});
		meter = Budget.record(meter, "s1", {
			used: 5,
			size: 100,
			cost: { amount: 0.8, currency: "USD" },
		});
		expect(meter.s1?.cost?.amount).toBe(0.8);
	});
});

describe("Budget.spent", () => {
	it("sums the latest cost per session in the budget currency and counts the rest unpriced", () => {
		let meter = Budget.record({}, "a", {
			used: 1,
			size: 1,
			cost: { amount: 1.25, currency: "USD" },
		});
		meter = Budget.record(meter, "a", {
			used: 1,
			size: 1,
			cost: { amount: 2, currency: "USD" },
		});
		meter = Budget.record(meter, "b", {
			used: 1,
			size: 1,
			cost: { amount: 1, currency: "USD" },
		});
		meter = Budget.record(meter, "c", { used: 1, size: 1 });
		meter = Budget.record(meter, "d", {
			used: 1,
			size: 1,
			cost: { amount: 9, currency: "EUR" },
		});
		expect(Budget.spent(meter, "USD")).toEqual({ amount: 3, unpriced: 2 });
	});
});

describe("Budget.check", () => {
	it("halts on wall time", () => {
		const b = budget({ wallMinutes: 30 });
		expect(Budget.check(b, {}, { startedAt: START, now: at(29) })).toEqual({
			ok: true,
		});
		const over = Budget.check(b, {}, { startedAt: START, now: at(30) });
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.reason).toBe("wall-time");
	});

	it("halts on spend only when a spend budget is set and a cost was reported", () => {
		const priced = Budget.record({}, "a", {
			used: 1,
			size: 1,
			cost: { amount: 5, currency: "USD" },
		});
		const unpriced = Budget.record({}, "a", { used: 1, size: 1 });
		const clock = { startedAt: START, now: at(1) };

		expect(Budget.check(budget(), priced, clock)).toEqual({ ok: true });
		expect(Budget.check(budget({ spend: 10 }), priced, clock)).toEqual({
			ok: true,
		});
		expect(Budget.check(budget({ spend: 5 }), unpriced, clock)).toEqual({
			ok: true,
		});
		const over = Budget.check(budget({ spend: 5 }), priced, clock);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.reason).toBe("spend");
	});
});

describe("Budget slots and continuations", () => {
	it("frees slots under the concurrency cap and never goes negative", () => {
		const b = budget({ concurrency: 3 });
		expect(Budget.slots(b, 0)).toBe(3);
		expect(Budget.slots(b, 2)).toBe(1);
		expect(Budget.slots(b, 5)).toBe(0);
	});

	it("allows exactly the configured number of continuations across the run", () => {
		const b = budget({ continuations: 2 });
		expect(Budget.canContinue(b, 0)).toBe(true);
		expect(Budget.canContinue(b, 1)).toBe(true);
		expect(Budget.canContinue(b, 2)).toBe(false);
		expect(Budget.canContinue(budget({ continuations: 0 }), 0)).toBe(false);
	});
});
