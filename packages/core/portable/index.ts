import { z } from "zod";
import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { Modules } from "../module";
import { SYNC_TABLES } from "../schemas/sync";
import { Migrations } from "../storage/migrations";
import { fingerprintText } from "../storage/read-fingerprint";

const cell = z.union([
	z.string(),
	z.number(),
	z.null(),
	z.object({ blob: z.string().regex(/^(?:[0-9a-f]{2})*$/) }),
	z.object({ integer: z.string().regex(/^-?\d+$/) }),
]);
const columns = z.record(z.string(), cell);
const binding = (value: z.infer<typeof cell>) => {
	if (typeof value !== "object" || value === null) return value;
	if ("integer" in value) return BigInt(value.integer);
	return Uint8Array.fromHex(value.blob);
};
const document = z.object({ table: z.string(), id: z.string(), row: columns });
type Document = z.infer<typeof document>;
const header = z.object({
	format: z.literal(1),
	core: z.number(),
	modules: z.record(z.string(), z.number()),
});
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const tables = () =>
	[...SYNC_TABLES, ...Modules.tables().map(({ spec }) => spec.table)].sort();
const versions = () => ({
	format: 1 as const,
	core: Migrations.SCHEMA_VERSION,
	modules: Object.fromEntries(
		Modules.list().map((m) => [m.name, Modules.schemaOf(m)]),
	),
});
type TableRows = {
	table: string;
	docs: Document[];
	owner?: { table: string; from: string };
};
// SQLite integers can exceed the exact range of a JSON number. Read their decimal
// spelling from SQLite before the adapter rounds it. A large REAL stays a number.
const storedCell = (
	db: Db,
	table: string,
	id: string,
	column: string,
	value: unknown,
) => {
	if (value instanceof Uint8Array) return { blob: value.toHex() };
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		!Number.isSafeInteger(value)
	) {
		const name = quote(column);
		const exact = db
			.query<{ n: string }>(
				`SELECT CAST(${name} AS TEXT) AS n FROM ${quote(table)} WHERE id=? AND typeof(${name})='integer'`,
			)
			.get(id);
		if (exact) return { integer: exact.n };
	}
	return value;
};
const readTable = (db: Db, table: string): TableRows => {
	const foreignKeys = db
		.query<{ table: string; from: string }>(
			`PRAGMA foreign_key_list(${quote(table)})`,
		)
		.all();
	const owner =
		foreignKeys.find(
			(key) => key.from === "task_id" || key.from === "thread_id",
		) ??
		foreignKeys.find(
			(key) => key.from === "source_id" || key.from === "source_thread_id",
		) ??
		(Modules.table(table)?.spec.childOfTasks
			? { table: TABLES.tasks, from: "task_id" }
			: undefined);
	const docs = db
		.query(`SELECT * FROM ${quote(table)} ORDER BY id`)
		.all()
		.map((raw) => {
			const id = z.string().parse(raw.id);
			const row = columns.parse(
				Object.fromEntries(
					Object.keys(raw)
						.sort()
						.map((key) => [key, storedCell(db, table, id, key, raw[key])]),
				),
			);
			return { table, id, row };
		});
	return { table, docs, owner };
};

export namespace Portable {
	export type Manifest = Record<string, { count: number; digest: string }>;

	export const snapshot = (db: Db): TableRows[] =>
		db.transaction(() => tables().map((table) => readTable(db, table)))();

	export const encode = (snapshot: TableRows[]): string => {
		const rootTables = new Set(snapshot.map((group) => group.owner?.table));
		const groups = new Map<string, Map<string, Document[]>>();
		for (const { table, docs } of snapshot) {
			if (rootTables.has(table))
				groups.set(table, new Map(docs.map((doc) => [doc.id, [doc]])));
		}
		const unowned: Document[] = [];
		for (const { table, docs, owner } of snapshot) {
			if (groups.has(table)) continue;
			for (const doc of docs) {
				const id = owner && doc.row[owner.from];
				const group =
					owner && typeof id === "string"
						? groups.get(owner.table)?.get(id)
						: undefined;
				(group ?? unowned).push(doc);
			}
		}
		const grouped = Array.from(groups.values()).flatMap((byId) =>
			Array.from(byId.values()).flat(),
		);
		return (
			[versions(), ...grouped, ...unowned]
				.map((item) => JSON.stringify(item))
				.join("\n") + "\n"
		);
	};

	export const manifest = async (snapshot: TableRows[]): Promise<Manifest> => {
		const result: Manifest = Object.create(null);
		for (const { table, docs } of snapshot) {
			const digest = await fingerprintText(
				docs.map((doc) => JSON.stringify(doc.row) + "\n").join(""),
			);
			if (!digest.ok) throw digest.error;
			result[table] = { count: docs.length, digest: digest.value };
		}
		return result;
	};

	export const compare = (source: Manifest, rebuilt: Manifest) =>
		Array.from(new Set([...Object.keys(source), ...Object.keys(rebuilt)]))
			.sort()
			.map((table) => {
				const a = source[table],
					b = rebuilt[table];
				return {
					table,
					source: a,
					rebuilt: b,
					match: !!a && !!b && a.count === b.count && a.digest === b.digest,
				};
			});

	/** Restore snapshots verbatim. Like sync apply, this bypasses local write capture. */
	export const restore = (db: Db, jsonl: string): void => {
		const lines = jsonl.trimEnd().split("\n");
		const parsed = header.safeParse(JSON.parse(lines.shift() ?? ""));
		const expected = versions();
		if (
			!parsed.success ||
			parsed.data.core !== expected.core ||
			Object.keys(parsed.data.modules).length !==
				Object.keys(expected.modules).length ||
			Object.entries(expected.modules).some(
				([name, version]) => parsed.data.modules[name] !== version,
			)
		)
			throw new Error(
				"Portable format or schema versions do not match this build",
			);
		db.transaction(() => {
			db.run("PRAGMA defer_foreign_keys = ON");
			const inserts = new Map(
				tables().map((table) => {
					const names = db
						.query<{ name: string }>(`PRAGMA table_info(${quote(table)})`)
						.all()
						.map((row) => row.name);
					const statement = db.prepare(
						`INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
					);
					return [table, { names, statement }];
				}),
			);
			const highest = new Map<string, number>();
			for (const line of lines) {
				const doc = document.parse(JSON.parse(line));
				const insert = inserts.get(doc.table);
				if (
					!insert ||
					doc.id !== doc.row.id ||
					Object.keys(doc.row).length !== insert.names.length ||
					!insert.names.every((key) => Object.hasOwn(doc.row, key))
				)
					throw new Error("Invalid portable row or table");
				insert.statement.run(
					...insert.names.map((key) => binding(doc.row[key] ?? null)),
				);
				const label = doc.row.short_id;
				const match = typeof label === "string" && /^(.+)-(\d+)$/.exec(label);
				if (match && match[1])
					highest.set(
						match[1],
						Math.max(highest.get(match[1]) ?? 0, Number(match[2])),
					);
			}
			// Reconstruct local counters so the first new item cannot reuse a restored label.
			for (const [prefix, number] of highest) {
				db.run(
					`INSERT INTO ${TABLES.sequences} (prefix,next_number,created_at) VALUES (?,?,?)`,
					[prefix, number, new Date().toISOString()],
				);
			}
		})();
	};
}
