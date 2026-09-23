import { describe, expect, it } from "bun:test";
import { Deadline, DeadlineSchema } from "./deadline";

describe("DeadlineSchema", () => {
	it("accepts both stored shapes: an ISO datetime and a calendar date", () => {
		expect(DeadlineSchema.safeParse("2026-02-06T23:59:59.000Z").success).toBe(
			true,
		);
		expect(DeadlineSchema.safeParse("2026-02-06").success).toBe(true);
	});

	it("rejects a date that is not on the calendar, and anything else", () => {
		expect(DeadlineSchema.safeParse("2026-02-30").success).toBe(false);
		expect(DeadlineSchema.safeParse("next friday").success).toBe(false);
		expect(DeadlineSchema.safeParse("2026-02-06 10:00").success).toBe(false);
	});
});

describe("Deadline.fromInput", () => {
	it("no input is no deadline", () => {
		expect(Deadline.fromInput(undefined)).toEqual({
			ok: true,
			value: undefined,
		});
	});

	it("a calendar date is due by the end of that day, UTC", () => {
		expect(Deadline.fromInput("2026-02-06")).toEqual({
			ok: true,
			value: "2026-02-06T23:59:59.000Z",
		});
	});

	it("an ISO datetime is kept, normalised to UTC", () => {
		expect(Deadline.fromInput("2026-02-06T10:00:00+02:00")).toEqual({
			ok: true,
			value: "2026-02-06T08:00:00.000Z",
		});
	});

	it("anything else is an error that says what to pass, never a dropped deadline", () => {
		for (const input of ["2026-02-30", "next friday", ""]) {
			const result = Deadline.fromInput(input);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.message).toContain("YYYY-MM-DD or an ISO datetime");
		}
	});
});
