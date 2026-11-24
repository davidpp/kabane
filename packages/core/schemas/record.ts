/**
 * The 2.0 record (ADR 0006): threads, entries, attributes, links and refs.
 *
 * Each row schema lists the table's columns, and is what sync apply accepts a
 * pulled row against. Columns stay soft strings (kinds, keys, states, types),
 * because a device that lacks a declaration must still store another device's
 * rows. Nothing writes these tables outside tests yet.
 *
 * A link, an attribute and a ref take an id derived from what makes them the
 * same row (`RecordId`), so two devices that create the same one make one row.
 */

import { z } from "zod";
import { sha256Hex } from "./sha256";

/** The record's tables, in the order a reader lists them. */
export const RECORD_TABLES = [
	"threads",
	"entries",
	"attributes",
	"links",
	"refs",
] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

export const isRecordTable = (tbl: string): tbl is RecordTable =>
	(RECORD_TABLES as readonly string[]).includes(tbl);

/** The record's tables whose ids are derived from a key (`RecordId`). */
export const KEYED_TABLES = ["attributes", "links", "refs"] as const;
export type KeyedTable = (typeof KEYED_TABLES)[number];

export const isKeyedTable = (tbl: string): tbl is KeyedTable =>
	(KEYED_TABLES as readonly string[]).includes(tbl);

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
	id: str,
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

export const LinkRowSchema = z.object({
	id: str,
	source_id: str,
	target_id: str,
	type: str,
	removed_at: clock.nullable(),
	visibility: str,
	updated_at: clock,
	updated_by: text,
	updated_device: str,
	version: counter,
});
export type LinkRow = z.infer<typeof LinkRowSchema>;

/** An `upstream` ref keeps the provider's id in `data` (`provider`, `externalId`). */
export const RefRowSchema = z.object({
	id: str,
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
	links: LinkRowSchema,
	refs: RefRowSchema,
} as const satisfies Record<RecordTable, z.ZodObject>;

/**
 * Ids derived from a row's key: `<tag>_<32 hex>`, the first 128 bits of the
 * SHA-256 of the JSON array `[tag, ...key]`. The JSON array keeps any two keys
 * apart whatever characters a URI holds, and the tag keeps two tables apart.
 * The output is never 26 characters and never matches the short id pattern,
 * so thread lookup cannot mistake it for a ULID or a label. Stable across
 * versions: changing it would split every derived row in two. Synchronous, so
 * a write or an apply derives it inside its transaction.
 */
export namespace RecordId {
	const derive = (tag: string, key: readonly string[]): string =>
		`${tag}_${sha256Hex(JSON.stringify([tag, ...key])).slice(0, 32)}`;

	export const link = (sourceId: string, targetId: string, type: string) =>
		derive("link", [sourceId, targetId, type]);

	export const attribute = (threadId: string, key: string) =>
		derive("attr", [threadId, key]);

	export const ref = (threadId: string, uri: string) =>
		derive("ref", [threadId, uri]);

	/** Keyed by the provider's own id, since the URL can change. */
	export const upstreamRef = (
		threadId: string,
		provider: string,
		externalId: string,
	) => derive("ref", ["upstream", threadId, provider, externalId]);

	const UpstreamKeySchema = z.object({
		provider: z.string(),
		externalId: z.string(),
	});

	const upstreamOf = (threadId: string, data: unknown): string | undefined => {
		if (typeof data !== "string") return undefined;
		let decoded: unknown;
		try {
			decoded = JSON.parse(data);
		} catch {
			return undefined;
		}
		const key = UpstreamKeySchema.safeParse(decoded);
		return key.success
			? upstreamRef(threadId, key.data.provider, key.data.externalId)
			: undefined;
	};

	const asString = (value: unknown): string | undefined =>
		typeof value === "string" ? value : undefined;

	/**
	 * The id a row of a keyed table must carry, derived from its own key, or
	 * undefined when the key cannot be read (an `upstream` ref whose `data`
	 * lacks the provider's id).
	 */
	export const forRow = (
		table: KeyedTable,
		row: Readonly<Record<string, unknown>>,
	): string | undefined => {
		const [a, b, c] = (
			table === "links"
				? [row.source_id, row.target_id, row.type]
				: [row.thread_id, table === "attributes" ? row.key : row.uri, ""]
		).map(asString);
		if (a === undefined || b === undefined || c === undefined) return undefined;
		if (table === "links") return link(a, b, c);
		if (table === "attributes") return attribute(a, b);
		return row.kind === "upstream" ? upstreamOf(a, row.data) : ref(a, b);
	};
}
