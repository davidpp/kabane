import type { z } from "zod";
import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { Replicated } from "../replicated";
import { err, ok, type Result, trySync } from "../result";
import { mintedLabel, SHORT_ID_PATTERN } from "../storage/helpers";
import { binding, document, header, idOf, quote, versions } from "./format";
import * as snapshots from "./snapshot";

/**
 * The modules whose schema an export must match: a module at schema 0 has no
 * migrations, so no table of its own, and an export is complete without it.
 */
const withSchema = (modules: Record<string, number>) =>
	Object.entries(modules).filter(([, version]) => version !== 0);

const readHeader = (line: string): Result<z.infer<typeof header>> => {
	const json = trySync(() => JSON.parse(line) as unknown);
	if (!json.ok) return err(new Error("Invalid portable header JSON"));
	const parsed = header.safeParse(json.value);
	const expected = withSchema(versions().modules);
	if (
		!parsed.success ||
		parsed.data.core !== versions().core ||
		withSchema(parsed.data.modules).length !== expected.length ||
		expected.some(([name, version]) => parsed.data.modules[name] !== version)
	)
		return err(
			new Error("Portable format or schema versions do not match this build"),
		);
	return ok(parsed.data);
};

const prepareInserts = (db: Db) =>
	new Map(
		Replicated.tables(db).map(({ table }) => {
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

type Counter = z.infer<typeof header>["counters"][number];

const reserveLabel = (
	counters: Map<string, Counter>,
	label: unknown,
	thread: boolean,
): Result<void> => {
	if (typeof label !== "string" || !SHORT_ID_PATTERN.test(label))
		return ok(undefined);
	const minted = mintedLabel(label);
	if (thread && !minted) return ok(undefined);
	const dash = label.indexOf("-");
	const prefix = minted?.prefix ?? label.slice(0, dash).toUpperCase();
	const number = minted?.number ?? Number(label.slice(dash + 1));
	if (!Number.isSafeInteger(number))
		return err(new Error("Restored short ID exceeds the counter range"));
	const counter = counters.get(prefix);
	if (counter) counter.next_number = Math.max(counter.next_number, number);
	else counters.set(prefix, { prefix, next_number: number, scope_uri: null });
	return ok(undefined);
};

export namespace Portable {
	export type Manifest = snapshots.Manifest;
	export const ManifestSchema = snapshots.ManifestSchema;
	export const snapshot = snapshots.snapshot;
	export const encode = snapshots.encode;
	export const manifest = snapshots.manifest;

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
	export const restore = (db: Db, jsonl: string): Result<void> => {
		const lines = jsonl.trimEnd().split("\n");
		const parsed = readHeader(lines.shift() ?? "");
		if (!parsed.ok) return parsed;
		return trySync(() =>
			db.transaction(() => {
				db.run("PRAGMA defer_foreign_keys = ON");
				const inserts = prepareInserts(db);
				const counters = new Map(
					parsed.value.counters.map((row) => [row.prefix, row]),
				);
				for (const [index, line] of lines.entries()) {
					const json = trySync(() => JSON.parse(line) as unknown);
					const doc = document.safeParse(json.ok ? json.value : undefined);
					if (!doc.success)
						throw new Error(`Invalid portable document on line ${index + 2}`);
					const { table, id, row } = doc.data;
					const insert = inserts.get(table);
					if (
						!insert ||
						id !== idOf(table, row) ||
						Object.keys(row).length !== insert.names.length ||
						!insert.names.every((key) => Object.hasOwn(row, key))
					)
						throw new Error(
							`Invalid portable row or table on line ${index + 2}`,
						);
					insert.statement.run(
						...insert.names.map((key) => binding(row[key] ?? null)),
					);
					if (table === Replicated.threadTable || table === TABLES.projects) {
						const reserved = reserveLabel(
							counters,
							row.short_id,
							table === Replicated.threadTable,
						);
						if (!reserved.ok) throw reserved.error;
					}
				}
				const now = new Date().toISOString();
				for (const row of counters.values()) {
					db.run(
						`INSERT INTO ${TABLES.sequences} (prefix,next_number,scope_uri,created_at) VALUES (?,?,?,?)`,
						[row.prefix, row.next_number, row.scope_uri, now],
					);
				}
			})(),
		);
	};
}
