/**
 * Planner Sync — Backfill
 *
 * Capture happens at write time, so a device that enables sync replicates only
 * what it changes *afterwards*. Everything already in the database is invisible
 * to the log. For the first device that is the whole history — thousands of
 * tasks that a second machine would never see.
 *
 * This synthesises the missing `insert` ops directly into `sync_oplog` through
 * the same `Oplog.snapshotOp` live capture uses, so a backfilled row and a
 * captured row are byte-identical on the wire. Re-writing 4000 rows to provoke
 * capture instead would rewrite their timestamps and their meaning.
 *
 * PRIVATE ROWS STAY HOME. The visibility filter is the same one live capture
 * applies; a row marked private is skipped and counted, never emitted.
 *
 * THE RECORD GOES FIRST. The tables come from `Replicated.tables`, the record's
 * before the rest: a data module's row names a thread, and the receiving
 * device skips it as an orphan when that thread has not arrived. The record
 * itself has no FK, so its order is free.
 *
 * IDEMPOTENT BY CONSTRUCTION. `op_id` is derived from table, row and version
 * rather than minted randomly, so a second run collides on `UNIQUE(op_id)` and
 * is ignored, while a row edited since the last run gets a fresh op. That
 * matters because the honest response to a half-finished backfill is to run it
 * again.
 */

import type { Db } from "../db/port";
import { Replicated } from "../replicated";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";

import { isRecordTable, RecordKey } from "../schemas";
import { Oplog } from "../storage/oplog";

/** Local mirror of the `oplog.ts` idiom — SQLite throws, this module does not. */
const trySync = <T>(fn: () => T): Result<T> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

// ============================================================
// Constants
// ============================================================

/**
 * Emission order, chosen so every FK parent precedes its children.
 *
 * `projects` first (`tasks.project_id` references it), then `tasks`, then the
 * four tables holding an FK to `tasks`.
 */
/**
 * Every replicated table this device writes (`Replicated.tables`), the
 * record's first: a module row names a thread, and a device applying it
 * checks the thread has arrived. The record has no FK, so its own order does
 * not matter.
 */
const backfillOrder = (db: Db): string[] => {
	const tables = Replicated.tables(db)
		.filter(({ unregisteredModule }) => unregisteredModule === undefined)
		.map(({ table }) => table);
	return [
		...tables.filter(isRecordTable),
		...tables.filter((table) => !isRecordTable(table)),
	];
};

/**
 * A row's write count, for its op id: a re-run is a no-op and a row written
 * since is re-emitted. A thread counts its claim and its delete too.
 */
const versionOf = (row: Record<string, unknown>): string => {
	const count = (value: unknown) => (typeof value === "number" ? value : 1);
	return row.state_version === undefined
		? String(count(row.version))
		: `${count(row.version)}.${count(row.state_version)}${row.deleted_at ? ".d" : ""}`;
};

// ============================================================
// Types
// ============================================================

type BackfillReport = {
	/** Ops written, per logical table. Absent means the table was empty. */
	byTable: Record<string, number>;
	/** Ops written this run. */
	written: number;
	/** Rows whose op already existed — a re-run, not a failure. */
	alreadyPresent: number;
	/** Rows kept out of the log by their `visibility`. */
	skippedPrivate: number;
};

// ============================================================
// Internals
// ============================================================

const emptyReport = (): BackfillReport => ({
	byTable: {},
	written: 0,
	alreadyPresent: 0,
	skippedPrivate: 0,
});

/**
 * Deterministic idempotency key. Prefixed so a backfilled op is recognisable in
 * the log and can never collide with live capture's random hex; versioned so a
 * row edited between two runs is re-emitted rather than treated as seen.
 */
const backfillOpId = (tbl: string, rowId: string, version: string): string =>
	`bf:${tbl}:${rowId}:v${version}`;

const backfillTable = (
	db: Db,
	tbl: string,
	deviceId: string,
	capturedAt: string,
	report: BackfillReport,
): Result<void> => {
	const rows = trySync(() =>
		db.query<Record<string, unknown>, []>(`SELECT * FROM ${tbl}`).all(),
	);
	if (!rows.ok) return rows;

	let written = 0;
	for (const row of rows.value) {
		const rowId = isRecordTable(tbl) ? RecordKey.rowIdOf(tbl, row) : row.id;
		if (typeof rowId !== "string") continue;
		if (!Oplog.isShared(row)) {
			report.skippedPrivate += 1;
			continue;
		}

		const version = versionOf(row);
		const done = Oplog.record(
			db,
			Oplog.snapshotOp({
				deviceId,
				tbl,
				op: "insert",
				row,
				capturedAt,
				opId: backfillOpId(tbl, rowId, version),
			}),
		);
		if (!done.ok) return done;

		// false means OR IGNORE swallowed a duplicate op_id.
		if (done.value) written += 1;
		else report.alreadyPresent += 1;
	}

	if (written > 0) report.byTable[tbl] = written;
	report.written += written;
	return ok(undefined);
};

// ============================================================
// Public API
// ============================================================

export namespace Backfill {
	/**
	 * Seed the oplog with the rows that predate capture.
	 *
	 * Requires the device to be armed: the ops need a `device_id`, and an
	 * unarmed device has no identity to stamp them with. The whole run is one
	 * transaction — a partial backfill would push a subset and then look, to a
	 * re-run, exactly like a complete one.
	 */
	export const run = async (
		basePath: string,
	): Promise<Result<BackfillReport>> => {
		const outer = await withDb(basePath, (db): Result<BackfillReport> => {
			const state = Oplog.getState(db);
			if (!state.ok) return state;
			if (state.value === undefined)
				return err(
					new Error(
						"Sync is not armed on this device, so backfilled ops would have no device identity. Run a sync first (kabane sync status), then backfill.",
					),
				);

			const deviceId = state.value.deviceId;
			const capturedAt = new Date().toISOString();
			const report = emptyReport();

			const run = trySync(() =>
				db.transaction(() => {
					for (const tbl of backfillOrder(db)) {
						const done = backfillTable(db, tbl, deviceId, capturedAt, report);
						// Inside a bun:sqlite transaction, throwing is the only way to
						// roll back — see JJAK-1077 on Transaction.atomic committing an
						// err Result.
						if (!done.ok) throw done.error;
					}
				})(),
			);
			if (!run.ok) return run;

			return ok(report);
		});
		return outer.ok ? outer.value : outer;
	};
}
