/**
 * Storage — the actor scheme's rename.
 *
 * An actor was `cabane://actor/...` until schema 12, a name kept from before the project was
 * called kabane, and is `kabane://actor/...` since (JCAB-607). Migration 12 renames core's
 * identity fields and `updated_by` in every op still in this device's log or parked; each data
 * module that stores actors appends its own migration for its table (`renameColumns`). Nothing
 * reads the old prefix afterwards: a process given one stops and points at `kabane doctor
 * --fix`, and an op pulled from a device still on schema 11 is not translated.
 */

import { ActorUri } from "../actor";
import type { Db } from "../db/port";
import { TABLES } from "./helpers";

type Row = Record<string, unknown>;

/** A JSON column's text with the actors it holds renamed; the same text when it holds none. */
type Nested = (raw: string) => string;

/** One table's identity fields: columns that hold an actor, and JSON columns that hold one inside. */
type Fields = {
	columns: readonly string[];
	nested?: Readonly<Record<string, Nested>>;
};

export namespace ActorScheme {
	export const LEGACY_PREFIX = "cabane://actor/";

	export const isLegacy = (value: unknown): value is string =>
		typeof value === "string" && value.startsWith(LEGACY_PREFIX);

	/** `value` under the scheme in force: renamed when it starts with the old prefix. */
	export const current = (value: string): string =>
		isLegacy(value)
			? `${ActorUri.PREFIX}${value.slice(LEGACY_PREFIX.length)}`
			: value;

	const isRow = (value: unknown): value is Row =>
		typeof value === "object" && value !== null && !Array.isArray(value);

	/** `raw` parsed, passed through `rename` and written back; `raw` when it is no JSON or nothing moved. */
	const inJson =
		(rename: (value: unknown) => unknown): Nested =>
		(raw) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Not JSON: nothing reads an actor in it, so nothing is renamed in it.
				return raw;
			}
			const renamed = rename(parsed);
			return renamed === parsed ? raw : JSON.stringify(renamed);
		};

	/** `object` with `key` renamed when it holds an actor under the old prefix; the same object otherwise. */
	const renamedKey = (object: unknown, key: string): unknown =>
		isRow(object) && isLegacy(object[key])
			? { ...object, [key]: current(object[key]) }
			: object;

	/** `task_work_log.refs`: a JSON array of work refs, each `addedBy` renamed. */
	const refs: Nested = inJson((value) => {
		if (!Array.isArray(value)) return value;
		const renamed = value.map((ref: unknown) => renamedKey(ref, "addedBy"));
		return renamed.some((ref, i) => ref !== value[i]) ? renamed : value;
	});

	/** `tasks.verification`: who verified is renamed; its notes are prose and stay as written. */
	const verification: Nested = inJson((value) =>
		renamedKey(value, "verifiedBy"),
	);

	/** `row`, a snapshot of a row of a table with `fields`, renamed; the same object when nothing moved. */
	const inRow = (row: Row, fields: Fields): Row => {
		let renamed = row;
		for (const column of fields.columns) {
			const value = row[column];
			if (isLegacy(value)) renamed = { ...renamed, [column]: current(value) };
		}
		for (const [column, nested] of Object.entries(fields.nested ?? {})) {
			const value = row[column];
			if (typeof value !== "string" || !value.includes(LEGACY_PREFIX)) continue;
			const next = nested(value);
			if (next !== value) renamed = { ...renamed, [column]: next };
		}
		return renamed;
	};

	/**
	 * The snapshots of `table`, every one when `table` is undefined, in this device's log and
	 * parked ops, with `fields` renamed. A parked op also carries its writer in its envelope
	 * (`updatedBy`, read from the snapshot's `updated_by` when it was captured), renamed with it.
	 */
	const renameSnapshots = (
		db: Db,
		table: string | undefined,
		fields: Fields,
	): void => {
		// The filters also catch a snapshot that only mentions the old prefix in its text;
		// `inRow` returns that one as it is.
		const filter = (column: string) =>
			`instr(${column}, ?) > 0${table === undefined ? "" : " AND tbl = ?"}`;
		const params =
			table === undefined ? [LEGACY_PREFIX] : [LEGACY_PREFIX, table];

		const ops = db
			.query<{ seq: number; payload: string }, string[]>(
				`SELECT seq, payload FROM ${TABLES.sync_oplog} WHERE ${filter("payload")}`,
			)
			.all(...params);
		for (const op of ops) {
			const row: unknown = JSON.parse(op.payload);
			if (!isRow(row)) continue;
			const renamed = inRow(row, fields);
			if (renamed !== row)
				db.run(`UPDATE ${TABLES.sync_oplog} SET payload = ? WHERE seq = ?`, [
					JSON.stringify(renamed),
					op.seq,
				]);
		}

		const parked = db
			.query<{ op_id: string; op: string }, string[]>(
				`SELECT op_id, op FROM ${TABLES.sync_parked} WHERE ${filter("op")}`,
			)
			.all(...params);
		for (const entry of parked) {
			const op: unknown = JSON.parse(entry.op);
			if (!isRow(op)) continue;
			let renamed = op;
			if (isRow(op.payload)) {
				const payload = inRow(op.payload, fields);
				if (payload !== op.payload) renamed = { ...renamed, payload };
			}
			if (fields.columns.includes("updated_by") && isLegacy(renamed.updatedBy))
				renamed = { ...renamed, updatedBy: current(renamed.updatedBy) };
			if (renamed !== op)
				db.run(`UPDATE ${TABLES.sync_parked} SET op = ? WHERE op_id = ?`, [
					JSON.stringify(renamed),
					entry.op_id,
				]);
		}
	};

	const rename = (db: Db, table: string, fields: Fields): void => {
		for (const column of fields.columns)
			db.run(
				`UPDATE ${table} SET ${column} = ? || substr(${column}, ?)
				  WHERE substr(${column}, 1, ?) = ?`,
				[
					ActorUri.PREFIX,
					LEGACY_PREFIX.length + 1,
					LEGACY_PREFIX.length,
					LEGACY_PREFIX,
				],
			);
		for (const [column, nested] of Object.entries(fields.nested ?? {})) {
			const rows = db
				.query<{ id: string; value: string }, [string]>(
					`SELECT id, ${column} AS value FROM ${table} WHERE instr(${column}, ?) > 0`,
				)
				.all(LEGACY_PREFIX);
			for (const row of rows) {
				const value = nested(row.value);
				if (value !== row.value)
					db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [
						value,
						row.id,
					]);
			}
		}
		renameSnapshots(db, table, fields);
	};

	/**
	 * Every value of `columns` in `table` that starts with the old prefix, renamed, in its rows
	 * and in the snapshots of its rows this device has logged or parked. A value that only
	 * mentions it further in is left as written.
	 */
	export const renameColumns = (
		db: Db,
		table: string,
		columns: readonly string[],
	): void => rename(db, table, { columns });

	/**
	 * Migration 12: core's identity fields, in its rows and in their logged snapshots, and
	 * `updated_by` in every logged or parked op of any table, the writer sync carries for every
	 * one. A module's other identity columns are its own migration's. No row's version or clock
	 * moves and nothing is captured: each device renames its own rows, and the same row renamed
	 * on two devices is the same row.
	 */
	export const migrate = (db: Db): void => {
		rename(db, TABLES.tasks, {
			columns: ["discovered_by", "reviewed_by", "updated_by"],
			nested: { verification },
		});
		rename(db, TABLES.comments, { columns: ["author", "updated_by"] });
		rename(db, TABLES.context_refs, { columns: ["added_by", "updated_by"] });
		rename(db, TABLES.work_log, {
			columns: ["updated_by"],
			nested: { refs },
		});
		for (const table of [
			TABLES.projects,
			TABLES.task_links,
			TABLES.upstream_links,
		])
			rename(db, table, { columns: ["updated_by"] });
		renameSnapshots(db, undefined, { columns: ["updated_by"] });
	};
}
