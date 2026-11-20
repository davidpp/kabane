/**
 * Storage — the actor scheme's rename.
 *
 * An actor was `cabane://actor/...` until schema 12, a name kept from before the project was
 * called kabane, and is `kabane://actor/...` since (JCAB-607). Migration 12 renames core's
 * identity columns and the ops still in this device's log; each data module that stores actors
 * appends its own migration for its table (`renameColumns`). Nothing reads the old prefix
 * afterwards: a process given one stops and points at `kabane doctor --fix`, and an op pulled
 * from a device still on schema 11 is not translated.
 */

import { ActorUri } from "../actor";
import type { Db } from "../db/port";
import { TABLES } from "./helpers";

type Row = Record<string, unknown>;

export namespace ActorScheme {
	export const LEGACY_PREFIX = "cabane://actor/";

	export const isLegacy = (value: unknown): value is string =>
		typeof value === "string" && value.startsWith(LEGACY_PREFIX);

	/** `value` under the scheme in force: renamed when it starts with the old prefix. */
	export const current = (value: string): string =>
		isLegacy(value)
			? `${ActorUri.PREFIX}${value.slice(LEGACY_PREFIX.length)}`
			: value;

	/**
	 * Every value of `columns` in `table` that starts with the old prefix, renamed. A value that
	 * only mentions it further in is left as written.
	 */
	export const renameColumns = (
		db: Db,
		table: string,
		columns: readonly string[],
	): void => {
		for (const column of columns)
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
	};

	/** A `task_work_log.refs` value, a JSON array of work refs, with each `addedBy` renamed. */
	const renamedRefs = (raw: string): string => {
		try {
			const refs: unknown = JSON.parse(raw);
			if (!Array.isArray(refs)) return raw;
			return JSON.stringify(
				refs.map((ref: unknown) =>
					typeof ref === "object" &&
					ref !== null &&
					"addedBy" in ref &&
					isLegacy(ref.addedBy)
						? { ...ref, addedBy: current(ref.addedBy) }
						: ref,
				),
			);
		} catch {
			// Not JSON: nothing reads it as refs, so nothing is renamed in it.
			return raw;
		}
	};

	/** A snapshot key that names a writer: `author`, and every `*_by` of core's and the modules' tables. */
	const namesActor = (key: string): boolean =>
		key === "author" || key.endsWith("_by");

	/**
	 * `row`, a snapshot of a stored row of any table, with its actors under the scheme in force.
	 * The same object when it holds none under the old one.
	 */
	const inRow = (row: Row): Row => {
		let renamed = row;
		for (const [key, value] of Object.entries(row)) {
			if (namesActor(key) && isLegacy(value))
				renamed = { ...renamed, [key]: current(value) };
			else if (
				key === "refs" &&
				typeof value === "string" &&
				value.includes(LEGACY_PREFIX)
			) {
				const refs = renamedRefs(value);
				if (refs !== value) renamed = { ...renamed, refs };
			}
		}
		return renamed;
	};

	const isRow = (value: unknown): value is Row =>
		typeof value === "object" && value !== null && !Array.isArray(value);

	/**
	 * Migration 12: core's identity columns, the `addedBy` of each work ref, and the row
	 * snapshots in this device's log and parked ops move to the scheme in force. No row's
	 * version or clock moves and nothing is captured: each device renames its own rows, and the
	 * same row renamed on two devices is the same row.
	 */
	export const migrate = (db: Db): void => {
		renameColumns(db, TABLES.tasks, [
			"discovered_by",
			"reviewed_by",
			"updated_by",
		]);
		renameColumns(db, TABLES.comments, ["author", "updated_by"]);
		renameColumns(db, TABLES.context_refs, ["added_by", "updated_by"]);
		for (const table of [
			TABLES.projects,
			TABLES.task_links,
			TABLES.work_log,
			TABLES.upstream_links,
		])
			renameColumns(db, table, ["updated_by"]);

		const withRefs = db
			.query<{ id: string; refs: string }, [string]>(
				`SELECT id, refs FROM ${TABLES.work_log} WHERE instr(refs, ?) > 0`,
			)
			.all(LEGACY_PREFIX);
		for (const log of withRefs) {
			const refs = renamedRefs(log.refs);
			if (refs !== log.refs)
				db.run(`UPDATE ${TABLES.work_log} SET refs = ? WHERE id = ?`, [
					refs,
					log.id,
				]);
		}

		// The filters also catch a snapshot that only mentions the old prefix in its text;
		// `inRow` returns that one as it is.
		const ops = db
			.query<{ seq: number; payload: string }, [string]>(
				`SELECT seq, payload FROM ${TABLES.sync_oplog} WHERE instr(payload, ?) > 0`,
			)
			.all(LEGACY_PREFIX);
		for (const op of ops) {
			const row: unknown = JSON.parse(op.payload);
			if (!isRow(row)) continue;
			const renamed = inRow(row);
			if (renamed === row) continue;
			db.run(`UPDATE ${TABLES.sync_oplog} SET payload = ? WHERE seq = ?`, [
				JSON.stringify(renamed),
				op.seq,
			]);
		}

		const parked = db
			.query<{ op_id: string; op: string }, [string]>(
				`SELECT op_id, op FROM ${TABLES.sync_parked} WHERE instr(op, ?) > 0`,
			)
			.all(LEGACY_PREFIX);
		for (const entry of parked) {
			const op: unknown = JSON.parse(entry.op);
			if (!isRow(op) || !isRow(op.payload)) continue;
			const payload = inRow(op.payload);
			if (payload === op.payload) continue;
			db.run(`UPDATE ${TABLES.sync_parked} SET op = ? WHERE op_id = ?`, [
				JSON.stringify({ ...op, payload }),
				entry.op_id,
			]);
		}
	};
}
