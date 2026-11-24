import { z } from "zod";
import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { Modules } from "../module";
import { isRecordTable, RECORD_KEYS, RecordKey } from "../schemas/record";
import { Migrations } from "../storage/migrations";

const cell = z.union([
	z.string(),
	z.number().finite(),
	z.null(),
	z.object({ blob: z.string().regex(/^(?:[0-9a-f]{2})*$/) }).strict(),
	z.object({ integer: z.string().regex(/^-?\d+$/) }).strict(),
]);

export const binding = (value: z.infer<typeof cell>) => {
	if (typeof value !== "object" || value === null) return value;
	if ("integer" in value) return BigInt(value.integer);
	return Uint8Array.fromHex(value.blob);
};

export const document = z.object({
	table: z.string(),
	id: z.string(),
	row: z.record(z.string(), cell),
});

export type Document = z.infer<typeof document>;

const counter = z.object({
	prefix: z.string(),
	next_number: z.number().int().safe().nonnegative(),
	scope_uri: z.string().nullable(),
});

export const header = z.object({
	format: z.literal(1),
	core: z.number(),
	modules: z.record(z.string(), z.number()),
	counters: z.array(counter).default([]),
});

export const versions = () => ({
	format: 1 as const,
	core: Migrations.SCHEMA_VERSION,
	modules: Object.fromEntries(
		Modules.list().map((m) => [m.name, Modules.schemaOf(m)]),
	),
});

export const readHeader = (db: Db) => ({
	...versions(),
	counters: db
		.query<z.infer<typeof counter>>(
			`SELECT prefix, next_number, scope_uri FROM ${TABLES.sequences} ORDER BY prefix`,
		)
		.all(),
});

export const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** A table's identity columns: a record table's key (`RECORD_KEYS`), any other's `id`. */
export const keyColumns = (table: string): readonly string[] =>
	isRecordTable(table) ? RECORD_KEYS[table] : ["id"];

/** A document's `id`: the row id sync gives the row (`RecordKey`), or its `id`. */
export const idOf = (
	table: string,
	row: Readonly<Record<string, unknown>>,
): unknown => (isRecordTable(table) ? RecordKey.rowIdOf(table, row) : row.id);
