import { z } from "zod";
import type { Db } from "../db/port";
import { Replicated } from "../replicated";
import { err, ok, type Result, toError } from "../result";
import { fingerprintText } from "../storage/read-fingerprint";
import { type Document, document, quote, readHeader } from "./format";

export const ManifestSchema = z.record(
	z.string(),
	z.object({
		count: z.number().int().nonnegative(),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	}),
);
export type Manifest = z.infer<typeof ManifestSchema>;

type TableRows = {
	table: string;
	threadColumn: string | null;
	docs: Document[];
	digestInput: string;
};
export type Snapshot = {
	header: ReturnType<typeof readHeader>;
	tables: TableRows[];
};
type Omission = { table: string; module: string; count: number };

// Quote text as bytes: quote(TEXT) stops at NUL, and adapters decode invalid UTF-8.
const quotedCell = (column: string) => {
	const name = quote(column);
	return `CASE WHEN typeof(${name})='text' THEN 'text:' || quote(CAST(${name} AS BLOB)) ELSE quote(${name}) END AS ${name}`;
};

const storedCell = (value: unknown, literal: string | undefined) => {
	if (value instanceof Uint8Array) return { blob: value.toHex() };
	// The adapter may round an integer when converting it to a JS number.
	if (
		typeof value === "number" &&
		!Number.isSafeInteger(value) &&
		literal &&
		/^-?\d+$/.test(literal)
	)
		return { integer: literal };
	return value;
};

const readTable = (
	db: Db,
	table: string,
	threadColumn: string | null,
): Result<TableRows> => {
	const name = quote(table);
	const names = db
		.query<{ name: string }>(`PRAGMA table_info(${name})`)
		.all()
		.map((column) => column.name)
		.sort();
	const literals = db
		.query<Record<string, string>>(
			`SELECT ${names.map(quotedCell).join(",")} FROM ${name} ORDER BY id`,
		)
		.all();
	const docs: Document[] = [];
	for (const [i, raw] of db
		.query(`SELECT * FROM ${name} ORDER BY id`)
		.all()
		.entries()) {
		const row = Object.fromEntries(
			names.map((key) => [key, storedCell(raw[key], literals[i]?.[key])]),
		);
		const parsed = document.safeParse({ table, id: raw.id, row });
		if (!parsed.success)
			return err(new Error(`Unsupported portable row in ${table}`));
		docs.push(parsed.data);
	}
	const digestInput = literals
		.map((row) => JSON.stringify(row) + "\n")
		.join("");
	return ok({ table, threadColumn, docs, digestInput });
};

export const snapshot = (
	db: Db,
): Result<Snapshot | { omitted: Omission[] }> => {
	try {
		return db.transaction(() => {
			const declarations = Replicated.tables(db);
			const omitted: Omission[] = [];
			for (const { table, unregisteredModule } of declarations) {
				if (unregisteredModule === undefined) continue;
				const row = db
					.query<{ count: number }>(
						`SELECT count(*) AS count FROM ${quote(table)}`,
					)
					.get();
				if (row && row.count > 0)
					omitted.push({ table, module: unregisteredModule, count: row.count });
			}
			if (omitted.length > 0) return ok({ omitted });
			const tables: TableRows[] = [];
			for (const { table, threadColumn, unregisteredModule } of declarations) {
				if (unregisteredModule !== undefined) continue;
				const rows = readTable(db, table, threadColumn);
				if (!rows.ok) return rows;
				tables.push(rows.value);
			}
			return ok({ header: readHeader(db), tables });
		})();
	} catch (error) {
		return err(toError(error));
	}
};

export const encode = ({ header, tables }: Snapshot): string => {
	const threads = tables.find(({ table }) => table === Replicated.threadTable);
	const groups = new Map(threads?.docs.map((doc) => [doc.id, [doc]]));
	const unowned: Document[] = [];
	for (const { table, docs, threadColumn } of tables) {
		if (table === Replicated.threadTable) continue;
		for (const doc of docs) {
			const id = threadColumn === null ? null : doc.row[threadColumn];
			const group = typeof id === "string" ? groups.get(id) : undefined;
			(group ?? unowned).push(doc);
		}
	}
	return [header, ...Array.from(groups.values()).flat(), ...unowned]
		.map((item) => JSON.stringify(item) + "\n")
		.join("");
};

export const manifest = async ({
	tables,
}: Snapshot): Promise<Result<Manifest>> => {
	const result: Manifest = Object.create(null);
	for (const { table, docs, digestInput } of tables) {
		const digest = await fingerprintText(digestInput);
		if (!digest.ok) return digest;
		result[table] = { count: docs.length, digest: digest.value };
	}
	return ok(result);
};
