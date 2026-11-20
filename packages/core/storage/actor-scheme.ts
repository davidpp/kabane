/**
 * Storage — the actor scheme's rename.
 *
 * An actor was `cabane://actor/...` until schema 12, a name kept from before the project was
 * called kabane, and is `kabane://actor/...` since (JCAB-607). Migration 12 renames core's
 * identity fields in its rows, and the actors of every op this device holds at that moment,
 * logged or parked, whichever table it is for; it types as `ai` every agent among them stored
 * as `human` (JCAB-598:3). Each data module that stores actors appends its own migration for
 * its table's rows (`renameColumns`). Nothing reads the old prefix afterwards: a process given
 * one stops and points at `kabane doctor --fix`, and an op pulled from a device still on schema
 * 11 is not translated, whenever its module registers.
 */

import { ActorUri } from "../actor";
import type { Db } from "../db/port";
import { TABLES } from "./helpers";

type Row = Record<string, unknown>;

/** A JSON column's text with the actors it holds renamed; the same text when it holds none. */
type Nested = (raw: string) => string;

/**
 * One table's identity fields: columns that hold an actor, JSON columns that hold one inside,
 * and the column beside an actor column that says whether it is a human or an AI.
 */
type Fields = {
	columns: readonly string[];
	nested?: Readonly<Record<string, Nested>>;
	/** Actor column → its type column. */
	types?: Readonly<Record<string, string>>;
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

	/** Whether a stored text may hold an actor this migration changes: an old one, or an agent. */
	const mentions = (value: string): boolean =>
		value.includes(LEGACY_PREFIX) || value.includes(ActorUri.AGENT);

	/**
	 * `object` with `typeKey` set to `ai` when `actorKey` names an agent and `typeKey` holds
	 * anything else: a session that already wrote the new prefix stored its agent as `human`.
	 * A type the object does not carry is not added.
	 */
	const typed = (object: Row, actorKey: string, typeKey: string): Row => {
		const actor = object[actorKey];
		return typeKey in object &&
			object[typeKey] !== "ai" &&
			typeof actor === "string" &&
			actor.startsWith(ActorUri.AGENT)
			? { ...object, [typeKey]: "ai" }
			: object;
	};

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

	/**
	 * `task_work_log.refs`: a JSON array of work refs, each `addedBy` renamed, and typed `ai` when
	 * it names an agent. Unlike a row's type column, a ref's `addedByType` is optional, so a ref
	 * by an agent that carries none gets one (JCAB-598:3).
	 */
	const refs: Nested = inJson((value) => {
		if (!Array.isArray(value)) return value;
		const renamed = value.map((ref: unknown) => {
			const named = renamedKey(ref, "addedBy");
			return isRow(named) &&
				named.addedByType !== "ai" &&
				typeof named.addedBy === "string" &&
				named.addedBy.startsWith(ActorUri.AGENT)
				? { ...named, addedByType: "ai" }
				: named;
		});
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
		for (const [actor, type] of Object.entries(fields.types ?? {}))
			renamed = typed(renamed, actor, type);
		for (const [column, nested] of Object.entries(fields.nested ?? {})) {
			const value = row[column];
			if (typeof value !== "string" || !mentions(value)) continue;
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
		// The filters also catch a snapshot that only mentions a prefix in its text; `inRow`
		// returns that one as it is.
		const filter = (column: string) =>
			`(instr(${column}, ?) > 0 OR instr(${column}, ?) > 0)${table === undefined ? "" : " AND tbl = ?"}`;
		const needles = [LEGACY_PREFIX, ActorUri.AGENT];
		const params = table === undefined ? needles : [...needles, table];

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

	const renameRows = (db: Db, table: string, fields: Fields): void => {
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
		for (const [actor, type] of Object.entries(fields.types ?? {}))
			db.run(
				`UPDATE ${table} SET ${type} = 'ai'
				  WHERE substr(${actor}, 1, ?) = ? AND ${type} IS NOT 'ai'`,
				[ActorUri.AGENT.length, ActorUri.AGENT],
			);
		for (const [column, nested] of Object.entries(fields.nested ?? {})) {
			const rows = db
				.query<{ id: string; value: string }, [string, string]>(
					`SELECT id, ${column} AS value FROM ${table}
					  WHERE instr(${column}, ?) > 0 OR instr(${column}, ?) > 0`,
				)
				.all(LEGACY_PREFIX, ActorUri.AGENT);
			for (const row of rows) {
				const value = nested(row.value);
				if (value !== row.value)
					db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [
						value,
						row.id,
					]);
			}
		}
	};

	const rename = (db: Db, table: string, fields: Fields): void => {
		renameRows(db, table, fields);
		renameSnapshots(db, table, fields);
	};

	/**
	 * Every value of `columns` in `table`'s rows that starts with the old prefix, renamed. A
	 * value that only mentions it further in is left as written. The snapshots of those rows
	 * were renamed by migration 12, whether the module was registered then or not.
	 */
	export const renameColumns = (
		db: Db,
		table: string,
		columns: readonly string[],
	): void => renameRows(db, table, { columns });

	/**
	 * The data modules' tables that held actors besides `updated_by` at schema 11, with those
	 * columns, as they stood then. Migration 12 renames their snapshots at the cutover, so an op
	 * this device logged before it leaves whole even when its module registers only later, and
	 * an op pulled after it stays as it came.
	 */
	const MODULE_ACTORS: Readonly<Record<string, readonly string[]>> = {
		task_questions: ["asked_by", "answered_by", "updated_by"],
		task_checklist_items: ["done_by", "updated_by"],
	};

	/**
	 * Migration 12: core's identity fields, in its rows and in their logged snapshots; the data
	 * modules' actors in their logged and parked snapshots (`MODULE_ACTORS`); and `updated_by`
	 * in every logged or parked op of any other table, the writer sync carries for every one. An
	 * agent typed `human` beside its actor becomes `ai`, and so does an agent's work ref that
	 * carries no type, in rows and snapshots alike. A module's
	 * rows are its own migration's. No row's version or clock
	 * moves and nothing is captured: each device renames its own rows, and the same row renamed
	 * on two devices is the same row.
	 */
	export const migrate = (db: Db): void => {
		rename(db, TABLES.tasks, {
			columns: ["discovered_by", "reviewed_by", "updated_by"],
			nested: { verification },
		});
		rename(db, TABLES.comments, {
			columns: ["author", "updated_by"],
			types: { author: "author_type" },
		});
		rename(db, TABLES.context_refs, {
			columns: ["added_by", "updated_by"],
			types: { added_by: "added_by_type" },
		});
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
		for (const [table, columns] of Object.entries(MODULE_ACTORS))
			renameSnapshots(db, table, { columns });
		renameSnapshots(db, undefined, { columns: ["updated_by"] });
	};
}
