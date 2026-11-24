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
import type { Result } from "../result";
import { map } from "../result";
import { fingerprintText } from "../storage/read-fingerprint";

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

const text = z.string().nullable();
const counter = z.number().int();

/**
 * A thread resolves in three groups, each with its own clock, counter and
 * writing device: the text (`updated_*`, `version`), the claim
 * (`state_updated_*`, `state_version`) and the delete (`deleted_*`).
 */
export const ThreadRowSchema = z.object({
	id: z.string(),
	short_id: text,
	kind: z.string(),
	kind_version: counter.nullable(),
	title: z.string(),
	body: text,
	scope: text,
	parent_id: text,
	created_by: text,
	created_at: z.string(),
	visibility: z.string(),
	updated_at: z.string(),
	updated_by: text,
	updated_device: z.string(),
	version: counter,
	state: text,
	assignee: text,
	state_updated_at: z.string(),
	state_updated_by: text,
	state_updated_device: z.string(),
	state_version: counter,
	deleted_at: text,
	deleted_device: text,
});
export type ThreadRow = z.infer<typeof ThreadRowSchema>;

/** Append-only. `addressed_to` is a JSON array of actors, `data` a JSON object. */
export const EntryRowSchema = z.object({
	id: z.string(),
	thread_id: z.string(),
	kind: z.string(),
	kind_version: counter.nullable(),
	author: z.string(),
	body: text,
	addressed_to: text,
	re: text,
	data: text,
	visibility: z.string(),
	created_at: z.string(),
	updated_by: text,
	created_device: z.string(),
	version: counter,
});
export type EntryRow = z.infer<typeof EntryRowSchema>;

/** One row per thread and key; `removed_at` is its tombstone. */
export const AttributeRowSchema = z.object({
	id: z.string(),
	thread_id: z.string(),
	key: z.string(),
	value: text,
	removed_at: text,
	visibility: z.string(),
	updated_at: z.string(),
	updated_by: text,
	updated_device: z.string(),
	version: counter,
});
export type AttributeRow = z.infer<typeof AttributeRowSchema>;

export const LinkRowSchema = z.object({
	id: z.string(),
	source_id: z.string(),
	target_id: z.string(),
	type: z.string(),
	removed_at: text,
	visibility: z.string(),
	updated_at: z.string(),
	updated_by: text,
	updated_device: z.string(),
	version: counter,
});
export type LinkRow = z.infer<typeof LinkRowSchema>;

/** An `upstream` ref keeps the provider's id in `data` (`provider`, `externalId`). */
export const RefRowSchema = z.object({
	id: z.string(),
	thread_id: z.string(),
	uri: z.string(),
	kind: z.string(),
	kind_version: counter.nullable(),
	title: text,
	data: text,
	removed_at: text,
	visibility: z.string(),
	updated_at: z.string(),
	updated_by: text,
	updated_device: z.string(),
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
 * versions: changing it would split every derived row in two.
 */
export namespace RecordId {
	const derive = async (
		tag: string,
		key: readonly string[],
	): Promise<Result<string>> =>
		map(
			await fingerprintText(JSON.stringify([tag, ...key])),
			(hex) => `${tag}_${hex.slice(0, 32)}`,
		);

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
}
