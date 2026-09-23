/**
 * Deadline conditions and ordering in SQL.
 *
 * SQLite cannot resolve an IANA timezone, so no per-row zone math happens in
 * SQL. Instead every bound is computed here, in the owner's zone, and each
 * condition splits by kind: a calendar date (`length(deadline) = 10`) compares
 * as a `YYYY-MM-DD` string against a local day, an instant compares as a
 * normalised UTC timestamp against an instant. Both are exact: a date's day
 * ends at `Deadline.endOfDay`, so "due by B" for a date is "its day is on or
 * before the local day that B closes".
 *
 * Instants are normalised with strftime because stored ones differ in
 * precision (`…T21:00:00Z` against `…T21:00:00.000Z`), which a plain string
 * comparison gets wrong.
 */

import type { Db } from "../db/port";
import { Deadline } from "../schemas/deadline";

export type SqlCondition = { sql: string; params: string[] };

const IS_DATE = "length(deadline) = 10";
const IS_INSTANT = "length(deadline) > 10";
const INSTANT = "strftime('%Y-%m-%dT%H:%M:%fZ', deadline)";

const iso = (at: number): string => new Date(at).toISOString();

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export namespace DeadlineSql {
	/** Today in `zone` at `now`: the local day and its first and last instants. */
	export type Today = { day: string; start: string; end: string };

	export const today = (now: number, zone: string): Today => {
		const day = Deadline.localDate(now, zone);
		return {
			day,
			start: iso(Deadline.startOfDay(day, zone)),
			end: iso(Deadline.endOfDay(day, zone)),
		};
	};

	/** Its day is before today. */
	export const overdue = (t: Today): SqlCondition => ({
		sql: `((${IS_DATE} AND deadline < ?) OR (${IS_INSTANT} AND ${INSTANT} < ?))`,
		params: [t.day, t.start],
	});

	/** Its day is today. */
	export const dueToday = (t: Today): SqlCondition => ({
		sql: `((${IS_DATE} AND deadline = ?) OR (${IS_INSTANT} AND ${INSTANT} >= ? AND ${INSTANT} <= ?))`,
		params: [t.day, t.start, t.end],
	});

	/** No deadline, or its day is after today. */
	export const noneOrLater = (t: Today): SqlCondition => ({
		sql: `(deadline IS NULL OR (${IS_DATE} AND deadline > ?) OR (${IS_INSTANT} AND ${INSTANT} > ?))`,
		params: [t.day, t.end],
	});

	/**
	 * Due at or before `bound`. A date bound includes its whole day; an instant
	 * bound takes a date deadline whose day ends by then.
	 */
	export const dueBefore = (bound: string, zone: string): SqlCondition => {
		const value = Deadline.parse(bound);
		if (!value.ok) return never;
		const [lastDay, lastInstant] =
			value.value.kind === "date"
				? [value.value.date, iso(Deadline.endOfDay(value.value.date, zone))]
				: [
						Deadline.addDays(Deadline.localDate(value.value.at + 1, zone), -1),
						iso(value.value.at),
					];
		return {
			sql: `((${IS_DATE} AND deadline <= ?) OR (${IS_INSTANT} AND ${INSTANT} <= ?))`,
			params: [lastDay, lastInstant],
		};
	};

	/**
	 * Due at or after `bound`. A date bound starts at its first instant; an
	 * instant bound takes a date deadline whose day has not ended by then.
	 */
	export const dueAfter = (bound: string, zone: string): SqlCondition => {
		const value = Deadline.parse(bound);
		if (!value.ok) return never;
		const [firstDay, firstInstant] =
			value.value.kind === "date"
				? [value.value.date, iso(Deadline.startOfDay(value.value.date, zone))]
				: [Deadline.localDate(value.value.at, zone), iso(value.value.at)];
		return {
			sql: `((${IS_DATE} AND deadline >= ?) OR (${IS_INSTANT} AND ${INSTANT} >= ?))`,
			params: [firstDay, firstInstant],
		};
	};

	const never: SqlCondition = { sql: "0", params: [] };

	/**
	 * An ORDER BY key: when each deadline falls due, as a UTC timestamp. A date's
	 * due instant depends on its day's offset (DST), so the key maps every date
	 * the table holds to its own end of day. The mapping is inlined rather than
	 * bound: Durable Object SQLite caps bound parameters per query, and every
	 * value is checked to be a date or an ISO instant before it is inlined.
	 */
	export const dueAtKey = (db: Db, table: string, zone: string): string => {
		const rows = db
			.query(
				`SELECT DISTINCT deadline FROM ${table} WHERE deadline IS NOT NULL AND ${IS_DATE}`,
			)
			.all() as { deadline: unknown }[];
		const branches = rows
			.map((row) => row.deadline)
			.filter(
				(date): date is string =>
					typeof date === "string" && CALENDAR_DATE.test(date),
			)
			.map((date) => [date, iso(Deadline.endOfDay(date, zone))] as const)
			.filter(([, due]) => ISO_INSTANT.test(due))
			.map(([date, due]) => `WHEN '${date}' THEN '${due}'`);
		const dateKey =
			branches.length > 0
				? `CASE deadline ${branches.join(" ")} ELSE deadline || 'T23:59:59.999Z' END`
				: "deadline || 'T23:59:59.999Z'";
		return `(CASE WHEN deadline IS NULL THEN NULL WHEN ${IS_DATE} THEN ${dateKey} ELSE ${INSTANT} END)`;
	};
}
