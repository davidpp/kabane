/**
 * Planner Storage — Sync Oplog
 *
 * Trigger-based change capture. Every mutation to a replicated base table
 * appends a row snapshot to `sync_oplog`, which a sync pass drains in
 * `seq` order.
 *
 * WHY TRIGGERS ARE BUILT HERE AND NOT IN `SCHEMA_SQL`: `prefixSql` rewrites
 * `CREATE TABLE`, `CREATE INDEX`, `REFERENCES x(` and `ON x(` — that last
 * pattern needs a paren, so `AFTER INSERT ON tasks` never matches, and neither
 * does `INSERT INTO sync_oplog` in a trigger body. Raw trigger DDL in
 * `SCHEMA_SQL` would silently target unprefixed tables that do not exist. So
 * triggers are generated from the already-prefixed `TABLES.*` constants, the
 * same way `generateFtsSql` does it (packages/core/db/registry.ts).
 *
 * CAPTURE IS ARMED BY DATA, NOT BY DDL. Triggers are installed unconditionally
 * but every one carries a `WHEN` clause that is false unless the `'local'`
 * `sync_state` row exists with `apply_guard = 0`. Two consequences:
 *   - a user who never enables sync pays baseline write cost
 *   - the applier can hold the guard while writing pulled ops, so applying does
 *     not re-capture and ping-pong forever
 *
 * SCHEMA DRIFT SELF-HEALS. Payload columns are read from `PRAGMA table_info`,
 * so they match the live table including columns added by `runMigrations`. Each
 * trigger records the column set it was built for in a `-- capture-cols:`
 * marker, and `ensureOplogTriggers` drops and recreates any trigger whose
 * marker no longer matches. Plain `CREATE TRIGGER IF NOT EXISTS` would leave a
 * stale trigger in place and a newly added column would silently never
 * replicate — the marker turns "runs on every boot" into actually converged.
 * A trigger already matching is left untouched, so the steady state performs
 * no writes.
 */

import { z } from "zod";
import type { Db } from "../db/port";
import { physicalTable, TABLES, tablePrefix } from "../db/tables";
import { err, ok, type Result } from "../result";
import {
	type QuarantinedOp,
	SYNC_TABLES,
	type SyncOp,
	type SyncOpKind,
	SyncOpKindSchema,
	SyncOpSchema,
	type SyncTable,
} from "../schemas";

// ============================================================
// Constants
// ============================================================

/** Primary key of the singleton `sync_state` row. */
const LOCAL_STATE_ID = "local";

/**
 * Trigger-name prefix. Carries the table prefix: trigger names share one
 * namespace with every other table's triggers in a shared database.
 */
const triggerPrefix = (): string => `${tablePrefix()}sync_cap`;

/**
 * Physical table for a replicated logical name. A function, not a map: the
 * prefix is configured at runtime, after this module is imported.
 */
export const physicalTableFor = (logical: SyncTable): string =>
	physicalTable(logical);

const TRIGGER_SUFFIX: Record<SyncOpKind, string> = {
	insert: "ins",
	update: "upd",
	delete: "del",
};

const TRIGGER_EVENT: Record<SyncOpKind, string> = {
	insert: "INSERT",
	update: "UPDATE",
	delete: "DELETE",
};

/** ISO-8601 with milliseconds, matching `new Date().toISOString()`. */
const CAPTURED_AT_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Marker embedded in every generated trigger recording the column set it
 * captures. SQLite stores a trigger's CREATE text verbatim apart from stripping
 * `IF NOT EXISTS` and the trailing semicolon, so comments survive and this is
 * readable back out of `sqlite_master` — which is what makes staleness
 * detectable without re-parsing the trigger body.
 */
const CAPTURE_COLS_MARKER = "-- capture-cols:";

/**
 * Capture is armed only while the singleton row exists AND the guard is down.
 * One clause covers both suppression cases.
 */
const armedSql = (): string => `WHEN EXISTS (
    SELECT 1 FROM ${TABLES.sync_state}
     WHERE id = '${LOCAL_STATE_ID}' AND apply_guard = 0
  )`;

// ============================================================
// Types
// ============================================================

/**
 * The singleton local replication cursor. Distinct from `SyncStatus`, which is
 * the human/agent-facing view (it adds `enabled` and `pendingOps` from config
 * and the oplog).
 */
export type SyncState = {
	deviceId: string;
	lastPushedSeq: number;
	lastAppliedSeq: number;
	applyGuard: boolean;
	lastSyncAt?: string;
	updatedAt: string;
};

/** A drained op carries its local `seq` so the caller knows what to ack. */
export type DrainedOp = SyncOp & { seq: number };

type OplogRow = {
	seq: number;
	op_id: string;
	device_id: string;
	tbl: string;
	row_id: string;
	op: string;
	row_updated_at: string | null;
	payload: string | null;
	captured_at: string;
};

type QuarantineRow = {
	op_id: string;
	tbl: string;
	row_id: string;
	bytes: number;
	reason: string;
	quarantined_at: string;
};

type SyncStateRow = {
	device_id: string;
	last_pushed_seq: number;
	last_applied_seq: number;
	apply_guard: number;
	last_sync_at: string | null;
	updated_at: string;
};

// ============================================================
// Private Helpers
// ============================================================

/** Sync counterpart to `tryCatch` — these run inside a caller-owned db. */
const trySync = <T>(fn: () => T): Result<T> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

const tableColumns = (db: Db, table: string): Result<string[]> =>
	trySync(() =>
		db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => row.name),
	);

const triggerName = (logical: SyncTable, op: SyncOpKind): string =>
	`${triggerPrefix()}_${logical}_${TRIGGER_SUFFIX[op]}`;

/** Canonical form of a captured column set, for the marker and for comparison. */
const columnFingerprint = (columns: string[]): string => columns.join(",");

/** The column set an installed trigger captures; undefined if unmarked. */
const installedFingerprint = (triggerSql: string): string | undefined =>
	triggerSql
		.split("\n")
		.find((line) => line.trim().startsWith(CAPTURE_COLS_MARKER))
		?.trim()
		.slice(CAPTURE_COLS_MARKER.length)
		.trim();

const existingTriggerSql = (db: Db, name: string): Result<string | undefined> =>
	trySync(
		() =>
			db
				.query<{ sql: string | null }, [string]>(
					`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
				)
				.get(name)?.sql ?? undefined,
	);

/** Full row snapshot keyed by column name. */
const jsonObjectSql = (ref: "NEW" | "OLD", columns: string[]): string =>
	`json_object(${columns.map((c) => `'${c}', ${ref}."${c}"`).join(", ")})`;

const captureTriggerSql = (args: {
	logical: SyncTable;
	physical: string;
	op: SyncOpKind;
	columns: string[];
	hasUpdatedAt: boolean;
}): string => {
	const { logical, physical, op, columns, hasUpdatedAt } = args;
	const ref = op === "delete" ? "OLD" : "NEW";

	// Deletes carry no snapshot; clock-less tables carry no LWW timestamp.
	const rowUpdatedAt =
		op === "delete" || !hasUpdatedAt ? "NULL" : `${ref}."updated_at"`;
	const payload = op === "delete" ? "NULL" : jsonObjectSql(ref, columns);

	return `CREATE TRIGGER IF NOT EXISTS ${triggerName(logical, op)}
  ${CAPTURE_COLS_MARKER} ${columnFingerprint(columns)}
  AFTER ${TRIGGER_EVENT[op]} ON ${physical}
  ${armedSql()}
  BEGIN
    INSERT INTO ${TABLES.sync_oplog}
      (op_id, device_id, tbl, row_id, op, row_updated_at, payload, captured_at)
    VALUES (
      lower(hex(randomblob(16))),
      (SELECT device_id FROM ${TABLES.sync_state} WHERE id = '${LOCAL_STATE_ID}'),
      '${logical}',
      ${ref}."id",
      '${op}',
      ${rowUpdatedAt},
      ${payload},
      ${CAPTURED_AT_SQL}
    );
  END;`;
};

const parsePayload = (
	raw: string | null,
): Result<Record<string, unknown> | undefined> => {
	if (raw === null) return ok(undefined);

	const decoded = trySync(() => JSON.parse(raw) as unknown);
	if (!decoded.ok) return decoded;

	const record = z.record(z.unknown()).safeParse(decoded.value);
	if (!record.success) {
		return err(
			new Error(`Oplog payload is not a JSON object: ${record.error.message}`),
		);
	}
	return ok(record.data);
};

const toDrainedOp = (row: OplogRow): Result<DrainedOp> => {
	const payload = parsePayload(row.payload);
	if (!payload.ok) return payload;

	const parsed = SyncOpSchema.safeParse({
		opId: row.op_id,
		deviceId: row.device_id,
		tbl: row.tbl,
		rowId: row.row_id,
		op: row.op,
		rowUpdatedAt: row.row_updated_at ?? undefined,
		payload: payload.value,
		capturedAt: row.captured_at,
	});
	if (!parsed.success) {
		return err(
			new Error(`Invalid oplog row at seq ${row.seq}: ${parsed.error.message}`),
		);
	}

	return ok({ ...parsed.data, seq: row.seq });
};

// ============================================================
// Oplog Namespace
// ============================================================

export namespace Oplog {
	/**
	 * Converge the capture triggers for every replicated table.
	 *
	 * Each trigger is (re)created only when it is missing or when the column set
	 * it records no longer matches the live table, so the steady state is 21
	 * cheap `sqlite_master` reads and no writes. Must run AFTER `runMigrations` —
	 * the tables and their migration-added columns have to exist first.
	 *
	 * @returns how many triggers were written; 0 means everything was current.
	 */
	export const ensureOplogTriggers = (db: Db): Result<number> => {
		let written = 0;

		for (const logical of SYNC_TABLES) {
			const physical = physicalTableFor(logical);

			const columns = tableColumns(db, physical);
			if (!columns.ok) return columns;
			if (columns.value.length === 0) {
				return err(
					new Error(
						`Cannot install capture triggers: table ${physical} does not exist`,
					),
				);
			}
			if (!columns.value.includes("id")) {
				return err(
					new Error(
						`Cannot install capture triggers: table ${physical} has no id column to use as row_id`,
					),
				);
			}

			const fingerprint = columnFingerprint(columns.value);
			const hasUpdatedAt = columns.value.includes("updated_at");

			for (const op of SyncOpKindSchema.options) {
				const name = triggerName(logical, op);

				const existing = existingTriggerSql(db, name);
				if (!existing.ok) return existing;
				if (
					existing.value !== undefined &&
					installedFingerprint(existing.value) === fingerprint
				) {
					continue;
				}

				// Stale or absent. DROP first — CREATE ... IF NOT EXISTS alone would
				// keep the old column set and the new column would never replicate.
				const rebuilt = trySync(() => {
					db.run(`DROP TRIGGER IF EXISTS ${name}`);
					db.run(
						captureTriggerSql({
							logical,
							physical,
							op,
							columns: columns.value,
							hasUpdatedAt,
						}),
					);
				});
				if (!rebuilt.ok) return rebuilt;
				written++;
			}
		}

		return ok(written);
	};

	/**
	 * Create the singleton state row, which is what arms capture.
	 *
	 * Device identity is write-once: a second call with a different id is a
	 * no-op rather than a rename, because changing `device_id` would make the
	 * remote treat this machine as new and hand back its own ops.
	 */
	export const initDevice = (db: Db, deviceId: string): Result<void> =>
		trySync(() => {
			db.run(
				`INSERT INTO ${TABLES.sync_state}
           (id, device_id, last_pushed_seq, last_applied_seq, apply_guard, last_sync_at, updated_at)
         VALUES (?, ?, 0, 0, 0, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
				[LOCAL_STATE_ID, deviceId, new Date().toISOString()],
			);
		});

	/** The local cursor, or undefined when sync was never initialized. */
	export const getState = (db: Db): Result<SyncState | undefined> => {
		const row = trySync(() =>
			db
				.query<SyncStateRow, [string]>(
					`SELECT device_id, last_pushed_seq, last_applied_seq, apply_guard, last_sync_at, updated_at
             FROM ${TABLES.sync_state} WHERE id = ?`,
				)
				.get(LOCAL_STATE_ID),
		);
		if (!row.ok) return row;
		if (!row.value) return ok(undefined);

		return ok({
			deviceId: row.value.device_id,
			lastPushedSeq: row.value.last_pushed_seq,
			lastAppliedSeq: row.value.last_applied_seq,
			applyGuard: row.value.apply_guard === 1,
			lastSyncAt: row.value.last_sync_at ?? undefined,
			updatedAt: row.value.updated_at,
		});
	};

	/**
	 * Unpushed ops in `seq` order, oldest first.
	 *
	 * With no `'local'` row the watermark subquery is NULL, `seq > NULL` is
	 * NULL, and the result is empty — sync being off drains nothing rather
	 * than erroring.
	 */
	export const drain = (db: Db, limit: number): Result<DrainedOp[]> => {
		const rows = trySync(() =>
			db
				.query<OplogRow, [number]>(
					`SELECT seq, op_id, device_id, tbl, row_id, op, row_updated_at, payload, captured_at
             FROM ${TABLES.sync_oplog}
            WHERE seq > (SELECT last_pushed_seq FROM ${TABLES.sync_state} WHERE id = '${LOCAL_STATE_ID}')
            ORDER BY seq ASC
            LIMIT ?`,
				)
				.all(limit),
		);
		if (!rows.ok) return rows;

		const ops: DrainedOp[] = [];
		for (const row of rows.value) {
			const op = toDrainedOp(row);
			if (!op.ok) return op;
			ops.push(op.value);
		}

		return ok(ops);
	};

	/**
	 * Record an op the remote will never accept, so skipping it is visible.
	 *
	 * Idempotent on `op_id`: the same op can be re-offered by a caller that
	 * drained before the quarantine landed, and a second refusal must not fail
	 * the pass.
	 */
	export const quarantine = (
		db: Db,
		entry: Omit<QuarantinedOp, "quarantinedAt">,
	): Result<void> =>
		trySync(() => {
			db.run(
				`INSERT INTO ${TABLES.sync_quarantine}
           (op_id, tbl, row_id, bytes, reason, quarantined_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(op_id) DO NOTHING`,
				[
					entry.opId,
					entry.tbl,
					entry.rowId,
					entry.bytes,
					entry.reason,
					new Date().toISOString(),
				],
			);
		});

	/** How many ops this device has given up on. */
	export const quarantineCount = (db: Db): Result<number> =>
		trySync(
			() =>
				db
					.query<{ count: number }, []>(
						`SELECT COUNT(*) AS count FROM ${TABLES.sync_quarantine}`,
					)
					.get()?.count ?? 0,
		);

	/** The most recently quarantined ops, newest first. */
	export const listQuarantined = (
		db: Db,
		limit: number,
	): Result<QuarantinedOp[]> =>
		trySync(() =>
			db
				.query<QuarantineRow, [number]>(
					`SELECT op_id, tbl, row_id, bytes, reason, quarantined_at
             FROM ${TABLES.sync_quarantine}
            ORDER BY quarantined_at DESC, op_id DESC
            LIMIT ?`,
				)
				.all(limit)
				.map((row) => ({
					opId: row.op_id,
					tbl: row.tbl,
					rowId: row.row_id,
					bytes: row.bytes,
					reason: row.reason,
					quarantinedAt: row.quarantined_at,
				})),
		);

	/** Advance the pushed watermark. Never moves backwards. */
	export const ack = (db: Db, throughSeq: number): Result<void> =>
		trySync(() => {
			db.run(
				`UPDATE ${TABLES.sync_state}
            SET last_pushed_seq = MAX(last_pushed_seq, ?), updated_at = ?
          WHERE id = ?`,
				[throughSeq, new Date().toISOString(), LOCAL_STATE_ID],
			);
		});

	/**
	 * Rewind the applied watermark to 0, so the next pull re-reads the whole log.
	 *
	 * For one situation only: the remote log was wiped or restored from a
	 * bookmark and its head is now BELOW this device's watermark. Left alone the
	 * device reads "caught up" forever and silently never syncs again. A direct
	 * write, not the `MAX(...)` every other watermark update uses — moving
	 * backwards is the entire point here.
	 */
	export const resetApplied = (db: Db): Result<void> =>
		trySync(() => {
			db.run(
				`UPDATE ${TABLES.sync_state} SET last_applied_seq = 0, updated_at = ? WHERE id = ?`,
				[new Date().toISOString(), LOCAL_STATE_ID],
			);
		});

	/** Raise or lower the capture guard. Prefer `withApplyGuard`. */
	export const setApplyGuard = (db: Db, on: boolean): Result<void> =>
		trySync(() => {
			db.run(
				`UPDATE ${TABLES.sync_state} SET apply_guard = ?, updated_at = ? WHERE id = ?`,
				[on ? 1 : 0, new Date().toISOString(), LOCAL_STATE_ID],
			);
		});

	/**
	 * Run `fn` with capture suppressed, clearing the guard on every exit path.
	 * A guard left raised would silently stop capturing forever, so a failure
	 * to clear it is surfaced rather than swallowed.
	 */
	export const withApplyGuard = async <T>(
		db: Db,
		fn: () => T | Promise<T>,
	): Promise<Result<T>> => {
		const raised = setApplyGuard(db, true);
		if (!raised.ok) return raised;

		try {
			const value = await fn();
			const lowered = setApplyGuard(db, false);
			if (!lowered.ok) return lowered;
			return ok(value);
		} catch (e) {
			setApplyGuard(db, false);
			return err(e instanceof Error ? e : new Error(String(e)));
		}
	};
}
