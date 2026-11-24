/**
 * The 2.0 record (ADR 0006): threads, entries, attributes and refs.
 *
 * Each row schema lists the table's columns, and is what sync apply accepts a
 * pulled row against. Columns stay soft strings (kinds, keys, states), because
 * a device that lacks a declaration must still store another device's rows.
 * Nothing writes these tables outside tests yet.
 *
 * A row's identity is its key (`RECORD_KEYS`): a thread's and an entry's id,
 * an attribute's thread and key, a ref's thread, URI and kind. Two devices
 * that set the same attribute or make the same ref write one row. A link
 * between threads is a ref to `kabane://thread/<id>` whose kind is the link's
 * type.
 */

import { z } from "zod";

/** The record's tables, in the order a reader lists them. */
export const RECORD_TABLES = [
	"threads",
	"entries",
	"attributes",
	"refs",
] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

export const isRecordTable = (tbl: string): tbl is RecordTable =>
	(RECORD_TABLES as readonly string[]).includes(tbl);

/** Each table's identity: its primary key, in order. */
export const RECORD_KEYS = {
	threads: ["id"],
	entries: ["id"],
	attributes: ["thread_id", "key"],
	refs: ["thread_id", "uri", "kind"],
} as const satisfies Record<RecordTable, readonly string[]>;

/**
 * A string SQLite stores as it was sent. An unpaired surrogate is replaced
 * when bound, so the value that won a comparison would not be the one stored.
 */
const str = z.string().refine((value) => value.isWellFormed(), {
	message: "holds ill-formed Unicode",
});
const text = str.nullable();
const counter = z.number().int();

/**
 * A clock in the one form that sorts as it reads: UTC, milliseconds, `Z`
 * (`Date.prototype.toISOString`). Registers and the claim holder compare
 * clocks as strings, so an offset or a missing fraction would misorder them.
 */
const clock = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
		message: "is not a UTC instant in toISOString form",
	});

/**
 * A thread resolves in three groups, each with its own clock, counter and
 * writing device: the text (`updated_*`, `version`), the claim
 * (`state_updated_*`, `state_version`) and the delete (`deleted_*`).
 */
export const ThreadRowSchema = z.object({
	id: str,
	short_id: text,
	kind: str,
	kind_version: counter.nullable(),
	title: str,
	body: text,
	scope: text,
	parent_id: text,
	created_by: text,
	created_at: clock,
	visibility: str,
	updated_at: clock,
	updated_by: text,
	updated_device: str,
	version: counter,
	state: text,
	assignee: text,
	state_updated_at: clock,
	state_updated_by: text,
	state_updated_device: str,
	state_version: counter,
	deleted_at: clock.nullable(),
	deleted_device: text,
});
export type ThreadRow = z.infer<typeof ThreadRowSchema>;

/** Append-only. `addressed_to` is a JSON array of actors, `data` a JSON object. */
export const EntryRowSchema = z.object({
	id: str,
	thread_id: str,
	kind: str,
	kind_version: counter.nullable(),
	author: str,
	body: text,
	addressed_to: text,
	re: text,
	data: text,
	visibility: str,
	created_at: clock,
	updated_by: text,
	created_device: str,
	version: counter,
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

/** One row per thread and key; `removed_at` is its tombstone. */
export const AttributeRowSchema = z.object({
	thread_id: str,
	key: str,
	value: text,
	removed_at: clock.nullable(),
	visibility: str,
	updated_at: clock,
	updated_by: text,
	updated_device: str,
	version: counter,
});
export type AttributeRow = z.infer<typeof AttributeRowSchema>;

/**
 * A URI a thread points at, as a `kind` of reference. A link to another
 * thread is a ref to `kabane://thread/<id>` (`RecordKey.threadUri`) with the
 * link type as its kind. An `upstream` ref's URI is the provider's stable id
 * for the item, and its URL, which can change, lives in `data`.
 */
export const RefRowSchema = z.object({
	thread_id: str,
	uri: str,
	kind: str,
	kind_version: counter.nullable(),
	title: text,
	data: text,
	removed_at: clock.nullable(),
	visibility: str,
	updated_at: clock,
	updated_by: text,
	updated_device: str,
	version: counter,
});
export type RefRow = z.infer<typeof RefRowSchema>;

export const RECORD_ROW_SCHEMAS = {
	threads: ThreadRowSchema,
	entries: EntryRowSchema,
	attributes: AttributeRowSchema,
	refs: RefRowSchema,
} as const satisfies Record<RecordTable, z.ZodObject>;

/**
 * How the sync log names a record row: `row_id` is one text. A one-column key
 * is that value. A composite key is the JSON array of its parts in key order,
 * `["<thread>","<key>"]`, which no part's characters can make ambiguous; the
 * array is written in `JSON.stringify` form, so one row has one `row_id`.
 */
export namespace RecordKey {
	/** What a ref's URI starts with when it points at a thread. */
	export const THREAD_URI_PREFIX = "kabane://thread/";

	export const rowIdOf = (
		table: RecordTable,
		row: Readonly<Record<string, unknown>>,
	): string | undefined => {
		const parts: string[] = [];
		for (const column of RECORD_KEYS[table]) {
			const part = row[column];
			if (typeof part !== "string") return undefined;
			parts.push(part);
		}
		return parts.length === 1 ? parts[0] : JSON.stringify(parts);
	};

	/** The key parts `rowId` names, or undefined when it is not a row id of `table`. */
	export const partsOf = (
		table: RecordTable,
		rowId: string,
	): string[] | undefined => {
		const columns = RECORD_KEYS[table];
		if (columns.length === 1) return [rowId];
		let decoded: unknown;
		try {
			decoded = JSON.parse(rowId);
		} catch {
			return undefined;
		}
		const parts = z.array(z.string()).length(columns.length).safeParse(decoded);
		return parts.success && JSON.stringify(parts.data) === rowId
			? parts.data
			: undefined;
	};

	/** The URI a ref uses to point at a thread. */
	export const threadUri = (threadId: string): string =>
		`${THREAD_URI_PREFIX}${threadId}`;
}
