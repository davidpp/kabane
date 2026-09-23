/**
 * Task Deadline
 *
 * A stored deadline has two shapes, and both are valid: an ISO datetime
 * (`2026-02-06T23:59:59.000Z`, what the CLI and the MCP tools write) and a
 * calendar date (`2026-02-06`, what other writers of the shared database store).
 * Both mean "due by then"; a calendar date falls due at the end of that day in
 * UTC, which is exactly the instant the CLI and the MCP tools write for the
 * same date, so the two shapes compare, sort and bucket identically.
 */

import { z } from "zod";
import { err, ok, type Result } from "../result";

/** A deadline as stored: an ISO datetime or a calendar date. */
export const DeadlineSchema = z.union([
	z.string().datetime(),
	z.string().date(),
]);

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export namespace Deadline {
	/**
	 * The instant a stored deadline falls due, as a SQL expression over the
	 * `deadline` column, for comparisons and ordering. A string comparison on the
	 * column alone would put `2026-02-06` before `2026-02-06T00:00:00.000Z` and so
	 * call a date due today overdue.
	 */
	export const DUE_AT_SQL =
		"(CASE WHEN length(deadline) = 10 THEN deadline || 'T23:59:59.999Z' ELSE deadline END)";

	/**
	 * A user's due date as the stored deadline: `YYYY-MM-DD` becomes the end of
	 * that day in UTC, an ISO datetime is normalised to UTC. Anything else is an
	 * error rather than a silently dropped deadline.
	 */
	export const fromInput = (
		input: string | undefined,
	): Result<string | undefined> => {
		if (input === undefined) return ok(undefined);
		if (CALENDAR_DATE.test(input)) {
			if (!z.string().date().safeParse(input).success)
				return err(invalid(input));
			return ok(`${input}T23:59:59.000Z`);
		}
		const date = new Date(input);
		return Number.isNaN(date.getTime())
			? err(invalid(input))
			: ok(date.toISOString());
	};

	const invalid = (input: string): Error =>
		new Error(`invalid due date "${input}": use YYYY-MM-DD or an ISO datetime`);
}
