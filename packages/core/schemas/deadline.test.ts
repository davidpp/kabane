import { describe, expect, it } from "bun:test";
import { Deadline, DeadlineSchema, TimeZoneSchema } from "./deadline";

const MONTREAL = "America/Montreal";
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

describe("DeadlineSchema", () => {
	it("accepts both kinds: a calendar date and an instant, with Z or an offset", () => {
		for (const stored of [
			"2026-02-06",
			"2026-02-06T23:59:59.000Z",
			"2026-02-06T21:00:00Z",
			"2026-02-06T10:00:00+02:00",
		])
			expect(DeadlineSchema.safeParse(stored).success).toBe(true);
	});

	it("rejects a date that is not on the calendar, and anything else", () => {
		for (const stored of [
			"2026-02-30",
			"next friday",
			"2026-02-06 10:00",
			"2026-02-06T10:00",
		])
			expect(DeadlineSchema.safeParse(stored).success).toBe(false);
	});
});

describe("TimeZoneSchema", () => {
	it("takes an IANA name the runtime knows and refuses anything else", () => {
		expect(TimeZoneSchema.safeParse(MONTREAL).success).toBe(true);
		expect(TimeZoneSchema.safeParse("UTC").success).toBe(true);
		expect(TimeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
		expect(TimeZoneSchema.safeParse("").success).toBe(false);
	});
});

describe("Deadline.parse", () => {
	it("tells a calendar date from an instant", () => {
		expect(Deadline.parse("2026-02-06")).toEqual({
			ok: true,
			value: { kind: "date", date: "2026-02-06" },
		});
		expect(Deadline.parse("2026-02-06T21:00:00Z")).toEqual({
			ok: true,
			value: { kind: "instant", at: at("2026-02-06T21:00:00.000Z") },
		});
	});

	it("an unreadable deadline is an error, never a guess", () => {
		expect(Deadline.parse("friday").ok).toBe(false);
		expect(Deadline.parse("2026-02-30").ok).toBe(false);
	});
});

describe("days in a zone", () => {
	it("a Montreal winter day runs from 05:00Z to 04:59:59.999Z the next day", () => {
		expect(iso(Deadline.startOfDay("2026-02-06", MONTREAL))).toBe(
			"2026-02-06T05:00:00.000Z",
		);
		expect(iso(Deadline.endOfDay("2026-02-06", MONTREAL))).toBe(
			"2026-02-07T04:59:59.999Z",
		);
	});

	it("the spring-forward day is 23 hours long", () => {
		const start = Deadline.startOfDay("2026-03-08", MONTREAL);
		const end = Deadline.endOfDay("2026-03-08", MONTREAL);
		expect(iso(start)).toBe("2026-03-08T05:00:00.000Z");
		expect(iso(end)).toBe("2026-03-09T03:59:59.999Z");
		expect(end + 1 - start).toBe(23 * 3_600_000);
	});

	it("the fall-back day is 25 hours long", () => {
		const start = Deadline.startOfDay("2026-11-01", MONTREAL);
		const end = Deadline.endOfDay("2026-11-01", MONTREAL);
		expect(iso(start)).toBe("2026-11-01T04:00:00.000Z");
		expect(iso(end)).toBe("2026-11-02T04:59:59.999Z");
		expect(end + 1 - start).toBe(25 * 3_600_000);
	});

	it("a day whose midnight DST skips starts at the first hour it has", () => {
		// Chile moved 2024-09-08 00:00 to 01:00 (UTC-4 to UTC-3).
		const start = Deadline.startOfDay("2024-09-08", "America/Santiago");
		expect(iso(start)).toBe("2024-09-08T04:00:00.000Z");
		expect(Deadline.localDate(start - 1, "America/Santiago")).toBe(
			"2024-09-07",
		);
	});

	it("23:30 in Montreal is still that day while UTC is already the next", () => {
		const lateEvening = at("2026-02-07T04:30:00.000Z");
		expect(Deadline.localDate(lateEvening, MONTREAL)).toBe("2026-02-06");
		expect(Deadline.localDate(lateEvening, "UTC")).toBe("2026-02-07");
	});

	it("addDays crosses months and years", () => {
		expect(Deadline.addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(Deadline.addDays("2026-01-01", -1)).toBe("2025-12-31");
	});
});

describe("stored deadlines in a zone", () => {
	const lateEvening = at("2026-02-07T04:30:00.000Z"); // 23:30 in Montreal

	it("a calendar date falls due at the end of its day where the owner is", () => {
		expect(Deadline.dueAt("2026-02-06", MONTREAL)).toEqual({
			ok: true,
			value: at("2026-02-07T04:59:59.999Z"),
		});
		expect(Deadline.dueAt("2026-02-06", "UTC")).toEqual({
			ok: true,
			value: at("2026-02-06T23:59:59.999Z"),
		});
	});

	it("buckets by the owner's day: at 23:30 local a date due today is not overdue", () => {
		expect(Deadline.bucket("2026-02-06", lateEvening, MONTREAL)).toEqual({
			ok: true,
			value: "today",
		});
		expect(Deadline.bucket("2026-02-06", lateEvening, "UTC")).toEqual({
			ok: true,
			value: "overdue",
		});
		expect(Deadline.bucket("2026-02-07", lateEvening, MONTREAL)).toEqual({
			ok: true,
			value: "later",
		});
		// 17:00 local on the 6th.
		expect(
			Deadline.isDueToday("2026-02-06T22:00:00.000Z", lateEvening, MONTREAL),
		).toBe(true);
		expect(Deadline.isOverdue("2026-02-05", lateEvening, MONTREAL)).toBe(true);
		expect(Deadline.isOverdue("garbage", lateEvening, MONTREAL)).toBe(false);
	});

	it("sorts an evening instant before the date of the same local day", () => {
		const evening = "2026-02-07T03:00:00.000Z"; // 22:00 on the 6th in Montreal
		expect(Deadline.compare(evening, "2026-02-06", MONTREAL)).toBeLessThan(0);
		expect(Deadline.compare(evening, "2026-02-06", "UTC")).toBeGreaterThan(0);
		expect(Deadline.compare("2026-02-06", "garbage", MONTREAL)).toBeLessThan(0);
	});

	it("formats a date as itself and an instant as local day and time", () => {
		expect(Deadline.format("2026-02-06", MONTREAL)).toBe("2026-02-06");
		expect(Deadline.format("2026-02-06T22:00:00.000Z", MONTREAL)).toBe(
			"2026-02-06 17:00",
		);
		expect(Deadline.format("2026-02-07T03:00:00.000Z", MONTREAL)).toBe(
			"2026-02-06 22:00",
		);
		expect(Deadline.format("garbage", MONTREAL)).toBe("garbage");
	});
});

describe("Deadline.fromInput", () => {
	it("no input is no deadline", () => {
		expect(Deadline.fromInput(undefined, MONTREAL)).toEqual({
			ok: true,
			value: undefined,
		});
	});

	it("a calendar date is stored as the date itself", () => {
		expect(Deadline.fromInput("2026-02-06", MONTREAL)).toEqual({
			ok: true,
			value: "2026-02-06",
		});
	});

	it("an ISO datetime with Z or an offset is that instant, stored in UTC", () => {
		expect(Deadline.fromInput("2026-02-06T10:00:00+02:00", MONTREAL)).toEqual({
			ok: true,
			value: "2026-02-06T08:00:00.000Z",
		});
		expect(Deadline.fromInput("2026-02-06T10:00:00Z", MONTREAL)).toEqual({
			ok: true,
			value: "2026-02-06T10:00:00.000Z",
		});
	});

	it("an ISO datetime without an offset is a local time in the owner's zone", () => {
		expect(Deadline.fromInput("2026-02-06T17:00", MONTREAL)).toEqual({
			ok: true,
			value: "2026-02-06T22:00:00.000Z",
		});
		expect(Deadline.fromInput("2026-02-06T17:00", "UTC")).toEqual({
			ok: true,
			value: "2026-02-06T17:00:00.000Z",
		});
	});

	it("a local time DST skips lands just after the jump; one it repeats is its first", () => {
		// 02:30 does not happen on 2026-03-08: 03:30 EDT.
		expect(Deadline.fromInput("2026-03-08T02:30", MONTREAL)).toEqual({
			ok: true,
			value: "2026-03-08T07:30:00.000Z",
		});
		// 01:30 happens twice on 2026-11-01: the EDT one comes first.
		expect(Deadline.fromInput("2026-11-01T01:30", MONTREAL)).toEqual({
			ok: true,
			value: "2026-11-01T05:30:00.000Z",
		});
	});

	it("anything else is an error that says what to pass, never a dropped deadline", () => {
		for (const input of [
			"2026-02-30",
			"next friday",
			"",
			"2026-02-06T25:00",
			"2026-02-06 10:00",
		]) {
			const result = Deadline.fromInput(input, MONTREAL);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.message).toContain("YYYY-MM-DD or an ISO datetime");
		}
	});
});
