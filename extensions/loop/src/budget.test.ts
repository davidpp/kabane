import { describe, expect, it } from "bun:test";
import { Budget } from "./budget";
import { LoopConfig } from "./config";

const budget = (input: LoopConfig.Input["budget"] = {}) => {
	const parsed = LoopConfig.Schema.safeParse({ budget: input });
	if (!parsed.success) throw parsed.error;
	return parsed.data.budget;
};

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
		expect(Budget.spent(meter, "USD", [])).toEqual({
			amount: 3,
			unpriced: 2,
		});
	});
});

describe("Budget.spent across resumed sessions", () => {
	const usd = (amount: number) => ({
		used: 1,
		size: 1,
		cost: { amount, currency: "USD" },
	});
	const meterOf = (costs: Record<string, number>): Budget.Meter =>
		Object.fromEntries(
			Object.entries(costs).map(([id, amount]) => [id, usd(amount)]),
		);

	it("counts a harness session resumed by later claims once, and a fresh fallback on top", () => {
		// Claude's total carries over a resume: 0.006 for the first claim, 0.0077 and 0.009 once
		// two gate retries resumed it, then a retry the harness refused, in a session of its own.
		const meter = meterOf({ c1: 0.006, c2: 0.0077, c3: 0.009, c4: 0.005 });
		const sessions = [
			{ sessionId: "c1", acpSessionId: "acp-1" },
			{ sessionId: "c2", acpSessionId: "acp-1" },
			{ sessionId: "c3", acpSessionId: "acp-1" },
			{ sessionId: "c4", acpSessionId: "acp-2" },
		];
		const { amount, unpriced } = Budget.spent(meter, "USD", sessions);
		expect(amount).toBeCloseTo(0.014, 10);
		expect(unpriced).toBe(0);
		expect(Budget.check(budget({ spend: 0.015 }), meter, sessions)).toEqual({
			ok: true,
		});
	});

	it("adds a total that went down whole: the harness counted that claim from zero", () => {
		const meter = meterOf({ c1: 0.006, c2: 0.002 });
		const sessions = [
			{ sessionId: "c1", acpSessionId: "acp-1" },
			{ sessionId: "c2", acpSessionId: "acp-1" },
		];
		expect(Budget.spent(meter, "USD", sessions).amount).toBeCloseTo(0.008, 10);
	});

	it("takes a claim that recorded no harness session, or no claim at all, as a session of its own", () => {
		const meter = meterOf({ c1: 0.006, c2: 0.007, lone: 0.001 });
		const sessions = [{ sessionId: "c1" }, { sessionId: "c2" }];
		expect(Budget.spent(meter, "USD", sessions).amount).toBeCloseTo(0.014, 10);
	});
});

describe("Budget.check", () => {
	it("halts on spend only when a spend budget is set and a cost was reported", () => {
		const priced = Budget.record({}, "a", {
			used: 1,
			size: 1,
			cost: { amount: 5, currency: "USD" },
		});
		const unpriced = Budget.record({}, "a", { used: 1, size: 1 });

		expect(Budget.check(budget(), priced, [])).toEqual({ ok: true });
		expect(Budget.check(budget({ spend: 10 }), priced, [])).toEqual({
			ok: true,
		});
		expect(Budget.check(budget({ spend: 5 }), unpriced, [])).toEqual({
			ok: true,
		});
		const over = Budget.check(budget({ spend: 5 }), priced, []);
		expect(over.ok).toBe(false);
		if (!over.ok) expect(over.reason).toBe("spend");
	});
});

describe("Budget slots and continuations", () => {
	it("frees slots under the concurrency cap and never goes negative", () => {
		expect(Budget.slots(3, 0)).toBe(3);
		expect(Budget.slots(3, 2)).toBe(1);
		expect(Budget.slots(3, 5)).toBe(0);
	});

	it("allows exactly the configured number of continuations across the run", () => {
		const b = budget({ continuations: 2 });
		expect(Budget.canContinue(b, 0)).toBe(true);
		expect(Budget.canContinue(b, 1)).toBe(true);
		expect(Budget.canContinue(b, 2)).toBe(false);
		expect(Budget.canContinue(budget({ continuations: 0 }), 0)).toBe(false);
	});
});
