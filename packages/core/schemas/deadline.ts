/**
 * Task Deadline
 *
 * A deadline is one of two kinds, and the stored string says which:
 *
 * - a calendar date, `2026-02-06`: due by the end of that day where its owner
 *   is. It has no zone; the owner's timezone decides when the day ends.
 * - an instant, `2026-02-06T17:00:00.000Z`: due at that moment, anywhere.
 *
 * Every comparison and display of a deadline goes through this namespace. A
 * string comparison on the column, or `new Date("2026-02-06")` (UTC midnight,
 * the evening before in the Americas), is how a date lands on the wrong day.
 *
 * The functions are pure and take the timezone as an IANA name, so a host
 * (the board, Jake's dashboard) reads a deadline exactly as the core buckets
 * it. `Runtime.timezone()` is the owner's zone the core itself uses.
 */

import { z } from "zod";
import { err, ok, type Result, trySync } from "../result";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** An ISO datetime with no offset: a wall-clock time in the owner's zone. */
const LOCAL_DATETIME =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const CalendarDateSchema = z.string().date();
const InstantSchema = z.string().datetime({ offset: true });

/** A deadline as stored: a calendar date or an instant. */
export const DeadlineSchema = z.union([InstantSchema, CalendarDateSchema]);

type WallClock = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const DAY_MS = 86_400_000;
const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export namespace Deadline {
	/** A parsed deadline. `at` is epoch milliseconds. */
	export type Value =
		| { kind: "date"; date: string }
		| { kind: "instant"; at: number };

	/** Where a deadline sits relative to today, in the owner's zone. */
	export type Bucket = "overdue" | "today" | "later";

	// ----------------------------------------------------------
	// Timezones and wall clocks
	// ----------------------------------------------------------

	const formatters = new Map<string, Intl.DateTimeFormat>();

	const formatter = (zone: string): Intl.DateTimeFormat => {
		const cached = formatters.get(zone);
		if (cached) return cached;
		const created = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			calendar: "iso8601",
			numberingSystem: "latn",
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(zone, created);
		return created;
	};

	/** True when the runtime can resolve `zone` (an IANA name). */
	export const isValidZone = (zone: string): boolean =>
		zone.length > 0 && trySync(() => formatter(zone)).ok;

	/** The zone the process runs in (honours `TZ`): the default owner's zone. */
	export const systemZone = (): string =>
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

	const wallClock = (at: number, zone: string): WallClock => {
		const parts: Record<string, number> = {};
		for (const part of formatter(zone).formatToParts(new Date(at))) {
			if (part.type !== "literal") parts[part.type] = Number(part.value);
		}
		return {
			year: parts.year ?? 1970,
			month: parts.month ?? 1,
			day: parts.day ?? 1,
			hour: parts.hour ?? 0,
			minute: parts.minute ?? 0,
			second: parts.second ?? 0,
		};
	};

	const wallAsUtc = (wall: WallClock): number =>
		Date.UTC(
			wall.year,
			wall.month - 1,
			wall.day,
			wall.hour,
			wall.minute,
			wall.second,
		);

	/** The zone's offset from UTC at `at`, in milliseconds (east positive). */
	const offsetAt = (at: number, zone: string): number => {
		const whole = Math.floor(at / 1000) * 1000;
		return wallAsUtc(wallClock(whole, zone)) - whole;
	};

	const sameWall = (a: WallClock, b: WallClock): boolean =>
		a.year === b.year &&
		a.month === b.month &&
		a.day === b.day &&
		a.hour === b.hour &&
		a.minute === b.minute &&
		a.second === b.second;

	/**
	 * The instant a wall-clock time names in `zone`. A time that happens twice
	 * (clocks going back) is its first occurrence; a time that never happens
	 * (clocks jumping forward) is the moment just after the jump, as Temporal's
	 * `compatible` disambiguation does.
	 */
	const fromWall = (wall: WallClock, ms: number, zone: string): number => {
		const target = wallAsUtc(wall);
		// Sampled half a day either side, so any transition near the target is
		// between them.
		const before = offsetAt(target - DAY_MS / 2, zone);
		const after = offsetAt(target + DAY_MS / 2, zone);
		const candidates = [target - before, target - after].filter((at) =>
			sameWall(wallClock(at, zone), wall),
		);
		if (candidates.length > 0) return Math.min(...candidates) + ms;
		// A gap: the wall time never shows. Read with the offset from before the
		// jump, it lands the same distance past the jump.
		return target - before + ms;
	};

	/** The calendar day `at` falls on in `zone`, as `YYYY-MM-DD`. */
	export const localDate = (at: number, zone: string): string => {
		const wall = wallClock(at, zone);
		return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
	};

	/** `date` (`YYYY-MM-DD`) moved by `days` calendar days. */
	export const addDays = (date: string, days: number): string => {
		const [year, month, day] = date.split("-").map(Number);
		const moved = new Date(
			Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days),
		);
		return moved.toISOString().slice(0, 10);
	};

	const dayStarts = new Map<string, number>();

	/** The first instant of `date` in `zone`. Usually midnight; DST can skip it. */
	export const startOfDay = (date: string, zone: string): number => {
		const key = `${zone}|${date}`;
		const cached = dayStarts.get(key);
		if (cached !== undefined) return cached;
		const [year, month, day] = date.split("-").map(Number);
		const start = fromWall(
			{
				year: year ?? 1970,
				month: month ?? 1,
				day: day ?? 1,
				hour: 0,
				minute: 0,
				second: 0,
			},
			0,
			zone,
		);
		dayStarts.set(key, start);
		return start;
	};

	/** The last millisecond of `date` in `zone`: when a date deadline falls due. */
	export const endOfDay = (date: string, zone: string): number =>
		startOfDay(addDays(date, 1), zone) - 1;

	// ----------------------------------------------------------
	// Stored deadlines
	// ----------------------------------------------------------

	/** Read a stored deadline. An unreadable string is an error, not a guess. */
	export const parse = (stored: string): Result<Value> => {
		if (CALENDAR_DATE.test(stored)) {
			return CalendarDateSchema.safeParse(stored).success
				? ok({ kind: "date", date: stored })
				: err(unreadable(stored));
		}
		if (!InstantSchema.safeParse(stored).success)
			return err(unreadable(stored));
		const at = Date.parse(stored);
		return Number.isNaN(at)
			? err(unreadable(stored))
			: ok({ kind: "instant", at });
	};

	/** When a stored deadline falls due, as epoch milliseconds. */
	export const dueAt = (stored: string, zone: string): Result<number> => {
		const value = parse(stored);
		if (!value.ok) return value;
		return ok(
			value.value.kind === "date"
				? endOfDay(value.value.date, zone)
				: value.value.at,
		);
	};

	/** The calendar day a stored deadline falls on in `zone`. */
	export const dayOf = (stored: string, zone: string): Result<string> => {
		const value = parse(stored);
		if (!value.ok) return value;
		return ok(
			value.value.kind === "date"
				? value.value.date
				: localDate(value.value.at, zone),
		);
	};

	/**
	 * Overdue (its day is before today), today, or later, with today taken at
	 * `now` (epoch ms) in `zone`: the buckets `Planner.getToday` returns.
	 */
	export const bucket = (
		stored: string,
		now: number,
		zone: string,
	): Result<Bucket> => {
		const day = dayOf(stored, zone);
		if (!day.ok) return day;
		const today = localDate(now, zone);
		return ok(
			day.value < today ? "overdue" : day.value === today ? "today" : "later",
		);
	};

	/** Its day is before today in `zone`. False for an unreadable deadline. */
	export const isOverdue = (
		stored: string,
		now: number,
		zone: string,
	): boolean => {
		const found = bucket(stored, now, zone);
		return found.ok && found.value === "overdue";
	};

	/** Its day is today in `zone`. False for an unreadable deadline. */
	export const isDueToday = (
		stored: string,
		now: number,
		zone: string,
	): boolean => {
		const found = bucket(stored, now, zone);
		return found.ok && found.value === "today";
	};

	/** Order two stored deadlines by when they fall due; an unreadable one sorts last. */
	export const compare = (a: string, b: string, zone: string): number => {
		const left = dueAt(a, zone);
		const right = dueAt(b, zone);
		if (!left.ok || !right.ok) return left.ok ? -1 : right.ok ? 1 : 0;
		return left.value - right.value;
	};

	/**
	 * A deadline for people: a date as itself, an instant as the local day and
	 * time in `zone` (`2026-02-06 17:00`). An unreadable one is shown as stored.
	 */
	export const format = (stored: string, zone: string): string => {
		const value = parse(stored);
		if (!value.ok) return stored;
		if (value.value.kind === "date") return value.value.date;
		const wall = wallClock(value.value.at, zone);
		return `${localDate(value.value.at, zone)} ${pad(wall.hour)}:${pad(wall.minute)}`;
	};

	// ----------------------------------------------------------
	// Input
	// ----------------------------------------------------------

	/**
	 * A user's due date as the stored deadline. `YYYY-MM-DD` is stored as that
	 * date; an ISO datetime with an offset or `Z` is stored as that instant in
	 * UTC; an ISO datetime without one is a wall-clock time in `zone`. Anything
	 * else is an error rather than a silently dropped deadline.
	 */
	export const fromInput = (
		input: string | undefined,
		zone: string,
	): Result<string | undefined> => {
		if (input === undefined) return ok(undefined);
		if (CALENDAR_DATE.test(input)) {
			return CalendarDateSchema.safeParse(input).success
				? ok(input)
				: err(invalid(input));
		}
		if (InstantSchema.safeParse(input).success) {
			const at = Date.parse(input);
			return Number.isNaN(at)
				? err(invalid(input))
				: ok(new Date(at).toISOString());
		}
		const local = LOCAL_DATETIME.exec(input);
		if (!local) return err(invalid(input));
		const [, year, month, day, hour, minute, second, fraction] = local;
		const wall: WallClock = {
			year: Number(year),
			month: Number(month),
			day: Number(day),
			hour: Number(hour),
			minute: Number(minute),
			second: Number(second ?? 0),
		};
		const onCalendar = CalendarDateSchema.safeParse(
			`${year}-${month}-${day}`,
		).success;
		if (!onCalendar || wall.hour > 23 || wall.minute > 59 || wall.second > 59)
			return err(invalid(input));
		const ms = Number((fraction ?? "0").padEnd(3, "0"));
		return ok(new Date(fromWall(wall, ms, zone)).toISOString());
	};

	const invalid = (input: string): Error =>
		new Error(`invalid due date "${input}": use YYYY-MM-DD or an ISO datetime`);

	const unreadable = (stored: string): Error =>
		new Error(
			`unreadable deadline "${stored}": not YYYY-MM-DD or an ISO datetime`,
		);
}

/** An IANA timezone name the runtime's Intl data knows, e.g. `America/Montreal`. */
export const TimeZoneSchema = z
	.string()
	.min(1)
	.refine((zone) => Deadline.isValidZone(zone), {
		message:
			"not a timezone this runtime knows (use an IANA name such as America/Montreal)",
	});
