/**
 * What a record row was written as, kept apart from its user-chosen kind
 * (JCAB-660). The `refs` table holds links, context refs and upstream links,
 * and `entries` holds the timeline and the work log; a kind is any string a
 * caller picks, so it cannot tell them apart. Each row says in `data.family`.
 */

import type { EntryRow, RefRow } from "../schemas";

export type RefFamily = "link" | "context" | "upstream";

/** The family of an entry that belongs to the work log; any other is the timeline's. */
export const WORK_LOG_FAMILY = "work_log";

/** The entry kind a work log is stored under. */
export const WORK_LOG_KIND = "log";

const familyIn = (data: string | null): unknown => {
	if (data === null) return undefined;
	const parsed: unknown = JSON.parse(data);
	return typeof parsed === "object" && parsed !== null
		? (parsed as { family?: unknown }).family
		: undefined;
};

export const refFamily = (row: RefRow): unknown => familyIn(row.data);

export const isWorkLog = (row: EntryRow): boolean =>
	familyIn(row.data) === WORK_LOG_FAMILY;
