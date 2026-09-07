/**
 * Planner Sync — Backfill
 *
 * Capture is trigger-based, so a device that enables sync replicates only what
 * it changes *afterwards*. Everything already in the database is invisible to
 * the log. For the first device that is the whole history — thousands of tasks
 * that a second machine would never see.
 *
 * This synthesises the missing `insert` ops directly into `planner_sync_oplog`,
 * which is the one place it is correct to write ops by hand: triggers fire on
 * base-table mutations, and re-writing 4000 rows to provoke them would rewrite
 * their timestamps and their meaning.
 *
 * ORDER IS FK ORDER. The receiving device applies in `seq` order inside one
 * transaction, and `foreign_keys = ON` there means a child arriving before its
 * parent aborts the whole batch. Parents are emitted first, and within `tasks`
 * the roots precede their subtasks.
 *
 * IDEMPOTENT BY CONSTRUCTION. `op_id` is derived from the table and row rather
 * than minted randomly, so a second run collides on `UNIQUE(op_id)` and is
 * ignored. That matters because the honest response to a half-finished backfill
 * is to run it again.
 */

import type { Db } from "../db/port";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";

import type { SyncTable } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Oplog, physicalTableFor } from "../storage/oplog";
import { CLOCK_COLUMN } from "./resolve";

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
 * four tables holding an FK to `tasks`. `focus_lists` has no FK and sorts last
 * only because it is the least interesting to see arrive.
 */
const BACKFILL_ORDER: readonly SyncTable[] = [
	"projects",
	"tasks",
	"task_links",
	"task_comments",
	"task_work_log",
	"task_context_refs",
	"focus_lists",
];

/**
 * `tasks.parent_task_id` references `tasks`, so a subtask emitted before its
 * parent would abort the receiver's batch. Roots first; one level of nesting is
 * all the planner allows, so this is sufficient rather than a topological sort.
 */
const ROW_ORDER: Partial<Record<SyncTable, string>> = {
	tasks: "(parent_task_id IS NOT NULL), id",
};

// ============================================================
// Types
// ============================================================

export type BackfillReport = {
	/** Ops written, per table. Absent means the table was empty. */
	byTable: Partial<Record<SyncTable, number>>;
	/** Ops written this run. */
	written: number;
	/** Rows whose op already existed — a re-run, not a failure. */
	alreadyPresent: number;
};

// ============================================================
// Internals
// ============================================================

const emptyReport = (): BackfillReport => ({
	byTable: {},
	written: 0,
	alreadyPresent: 0,
});

/**
 * Deterministic idempotency key. Prefixed so a backfilled op is recognisable in
 * the log, and so it can never collide with a trigger's random hex.
 */
const backfillOpId = (tbl: SyncTable, rowId: string): string =>
	`bf:${tbl}:${rowId}`;

const backfillTable = (
	db: Db,
	tbl: SyncTable,
	deviceId: string,
	capturedAt: string,
	report: BackfillReport,
): Result<void> => {
	const physical = physicalTableFor(tbl);
	const order = ROW_ORDER[tbl] ?? "id";
	const clock = CLOCK_COLUMN[tbl];

	const rows = trySync(() =>
		db
			.query<Record<string, unknown>, []>(
				`SELECT * FROM ${physical} ORDER BY ${order}`,
			)
			.all(),
	);
	if (!rows.ok) return rows;

	const insert = db.prepare(
		`INSERT OR IGNORE INTO ${TABLES.sync_oplog}
       (op_id, device_id, tbl, row_id, op, row_updated_at, payload, captured_at)
     VALUES (?, ?, ?, ?, 'insert', ?, ?, ?)`,
	);

	let written = 0;
	for (const row of rows.value) {
		const rowId = row.id;
		if (typeof rowId !== "string") continue;

		const clockValue = clock === undefined ? null : (row[clock] ?? null);
		const done = trySync(() =>
			insert.run(
				backfillOpId(tbl, rowId),
				deviceId,
				tbl,
				rowId,
				typeof clockValue === "string" ? clockValue : null,
				JSON.stringify(row),
				capturedAt,
			),
		);
		if (!done.ok) return done;

		// changes === 0 means OR IGNORE swallowed a duplicate op_id.
		if (done.value.changes > 0) written += 1;
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
						"Sync is not armed on this device, so backfilled ops would have no device identity. Run a sync first (jake plan sync status), then backfill.",
					),
				);

			const deviceId = state.value.deviceId;
			const capturedAt = new Date().toISOString();
			const report = emptyReport();

			const run = trySync(() =>
				db.transaction(() => {
					for (const tbl of BACKFILL_ORDER) {
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
