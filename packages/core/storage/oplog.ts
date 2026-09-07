/**
 * Storage — Sync Oplog
 *
 * Explicit change capture. Every storage write on a replicated table ends with
 * a capture call inside the same connection, which appends a row snapshot to
 * `sync_oplog`; a sync pass drains those ops in `seq` order.
 *
 * WHY EXPLICIT AND NOT TRIGGERS. Capture used to be SQLite triggers generated
 * in code. Two things killed that: `CREATE TRIGGER` is undocumented on Durable
 * Object SQLite, so the hub could not share the capture path; and a trigger
 * fires for every writer, so the applier needed a database-level guard to stop
 * pulled rows from being re-captured. With capture as a storage-layer step the
 * applier, which writes rows directly, never enters it, and there is nothing to
 * guard. The `apply_guard` column on `sync_state` is legacy and unread.
 *
 * CAPTURE IS ARMED BY DATA. Nothing is recorded unless the singleton `'local'`
 * row in `sync_state` exists — a user who never enables sync pays one indexed
 * read per write and nothing else.
 *
 * VISIBILITY IS THE FILTER. A row whose `visibility` is `'private'` never
 * becomes an op, whatever table it lives in. The set of tables that replicate
 * (`SYNC_TABLES`) is still declared, because the resolver needs a family per
 * table, but the per-row decision is the column.
 *
 * DELETES ARE CAPTURED FROM THE ROW THAT WAS. A delete carries no payload, but
 * the visibility check and the cascade walk both need the row before it is
 * gone, so callers snapshot first (`Oplog.snapshot`, `Oplog.cascadeOf`) and
 * capture after.
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
	SyncOpSchema,
	type SyncTable,
} from "../schemas";

// ============================================================
// Constants
// ============================================================

/** Primary key of the singleton `sync_state` row. */
const LOCAL_STATE_ID = "local";

/** The `visibility` value that keeps a row out of the log. */
export const PRIVATE = "private";

/**
 * Physical table for a replicated logical name. A function, not a map: the
 * prefix is configured at runtime, after this module is imported.
 */
export const physicalTableFor = (logical: SyncTable): string =>
	physicalTable(logical);

/**
 * Trigger-name suffixes the previous capture design installed. Dropped on boot
 * so a database upgraded from trigger capture does not record every write twice.
 */
const LEGACY_TRIGGER_SUFFIX = ["ins", "upd", "del"] as const;

// ============================================================
// Types
// ============================================================

/** A row snapshot keyed by DB column name. */
export type Row = Record<string, unknown>;

/**
 * The singleton local replication cursor. Distinct from `SyncStatus`, which is
 * the human/agent-facing view (it adds `enabled` and `pendingOps` from config
 * and the oplog).
 */
export type SyncState = {
	deviceId: string;
	lastPushedSeq: number;
	lastAppliedSeq: number;
	lastSyncAt?: string;
	updatedAt: string;
};

/** A drained op carries its local `seq` so the caller knows what to ack. */
export type DrainedOp = SyncOp & { seq: number };

/** What a caller hands to capture: which row, in which table, did what. */
export type CaptureInput = {
	tbl: SyncTable;
	op: SyncOpKind;
	/** The row as it is (insert/update) or as it was (delete). */
	row: Row;
};

/** Rows about to go, ordered so children precede their parent. */
export type Cascade = { tbl: SyncTable; row: Row }[];

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

const asString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" ? value : undefined;

const randomOpId = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

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
		updatedBy: asString(payload.value?.updated_by),
		version: asNumber(payload.value?.version),
		capturedAt: row.captured_at,
	});
	if (!parsed.success) {
		return err(
			new Error(`Invalid oplog row at seq ${row.seq}: ${parsed.error.message}`),
		);
	}

	return ok({ ...parsed.data, seq: row.seq });
};

const selectRows = (
	db: Db,
	physical: string,
	where: string,
	params: string[],
): Row[] =>
	db
		.query<Row, string[]>(`SELECT * FROM ${physical} WHERE ${where}`)
		.all(...params);

/**
 * Everything the FK cascade will remove when `taskId` goes: the same walk for
 * every subtask first (deepest first), then the task's own rows in the four
 * child tables, then the task itself. Subtasks nest one level in practice; the
 * walk is recursive so a deeper tree is still emitted FK-safely.
 */
const cascadeOfTask = (db: Db, taskId: string): Cascade => {
	const out: Cascade = [];
	for (const subtask of selectRows(db, TABLES.tasks, "parent_task_id = ?", [
		taskId,
	])) {
		const id = asString(subtask.id);
		if (id !== undefined) out.push(...cascadeOfTask(db, id));
	}

	const children: [SyncTable, string, string, string[]][] = [
		["task_comments", TABLES.comments, "task_id = ?", [taskId]],
		["task_work_log", TABLES.work_log, "task_id = ?", [taskId]],
		["task_context_refs", TABLES.context_refs, "task_id = ?", [taskId]],
		[
			"task_links",
			TABLES.task_links,
			"source_id = ? OR target_id = ?",
			[taskId, taskId],
		],
	];
	for (const [tbl, physical, where, params] of children) {
		for (const row of selectRows(db, physical, where, params)) {
			out.push({ tbl, row });
		}
	}

	const self = selectRows(db, TABLES.tasks, "id = ?", [taskId])[0];
	if (self !== undefined) out.push({ tbl: "tasks", row: self });
	return out;
};

// ============================================================
// Oplog Namespace
// ============================================================

export namespace Oplog {
	/**
	 * Row snapshot → op. Pure: no database, no clock, no randomness beyond the
	 * caller-supplied id. The one place the wire shape of a captured row is
	 * decided, shared by live capture and by backfill.
	 */
	export const snapshotOp = (args: {
		deviceId: string;
		tbl: SyncTable;
		op: SyncOpKind;
		row: Row;
		capturedAt: string;
		opId?: string;
	}): SyncOp => {
		const isDelete = args.op === "delete";
		return {
			opId: args.opId ?? randomOpId(),
			deviceId: args.deviceId,
			tbl: args.tbl,
			rowId: asString(args.row.id) ?? "",
			op: args.op,
			rowUpdatedAt: isDelete ? undefined : asString(args.row.updated_at),
			payload: isDelete ? undefined : args.row,
			updatedBy: isDelete ? undefined : asString(args.row.updated_by),
			version: isDelete ? undefined : asNumber(args.row.version),
			capturedAt: args.capturedAt,
		};
	};

	/** Whether a row snapshot may enter the log. The filter is the column. */
	export const isShared = (row: Row): boolean => row.visibility !== PRIVATE;

	/** Write an already-built op. Idempotent on `op_id`. */
	export const record = (db: Db, op: SyncOp): Result<boolean> =>
		trySync(
			() =>
				db.run(
					`INSERT OR IGNORE INTO ${TABLES.sync_oplog}
             (op_id, device_id, tbl, row_id, op, row_updated_at, payload, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						op.opId,
						op.deviceId,
						op.tbl,
						op.rowId,
						op.op,
						op.rowUpdatedAt ?? null,
						op.payload === undefined ? null : JSON.stringify(op.payload),
						op.capturedAt,
					],
				).changes > 0,
		);

	/**
	 * The storage layer's one capture step. `ok(false)` means nothing was
	 * recorded: sync is not armed, or the row is private.
	 */
	export const capture = (db: Db, input: CaptureInput): Result<boolean> => {
		const state = getState(db);
		if (!state.ok) return state;
		if (state.value === undefined) return ok(false);
		if (!isShared(input.row)) return ok(false);

		return record(
			db,
			snapshotOp({
				deviceId: state.value.deviceId,
				tbl: input.tbl,
				op: input.op,
				row: input.row,
				capturedAt: new Date().toISOString(),
			}),
		);
	};

	/**
	 * `captureRow`, for use inside a `withDb` callback: a capture failure throws,
	 * which the provider turns into the callback's `err`. Keeps every storage
	 * write to one line of capture instead of a Result dance per function.
	 */
	export const afterWrite = (
		db: Db,
		tbl: SyncTable,
		op: Exclude<SyncOpKind, "delete">,
		rowId: string,
	): void => {
		const captured = captureRow(db, tbl, op, rowId);
		if (!captured.ok) throw captured.error;
	};

	/** `captureDeletes` with the same throw-on-failure contract as `afterWrite`. */
	export const afterDelete = (db: Db, rows: Cascade): void => {
		const captured = captureDeletes(db, rows);
		if (!captured.ok) throw captured.error;
	};

	/** Capture the current state of `rowId` as an insert or update. */
	export const captureRow = (
		db: Db,
		tbl: SyncTable,
		op: Exclude<SyncOpKind, "delete">,
		rowId: string,
	): Result<boolean> => {
		const row = snapshot(db, tbl, rowId);
		if (!row.ok) return row;
		if (row.value === undefined) return ok(false);
		return capture(db, { tbl, op, row: row.value });
	};

	/** Capture several rows as deletes, in the order given. */
	export const captureDeletes = (db: Db, rows: Cascade): Result<number> => {
		let recorded = 0;
		for (const { tbl, row } of rows) {
			const done = capture(db, { tbl, op: "delete", row });
			if (!done.ok) return done;
			if (done.value) recorded++;
		}
		return ok(recorded);
	};

	/** The row as it is now, for a capture or for a pre-delete snapshot. */
	export const snapshot = (
		db: Db,
		tbl: SyncTable,
		rowId: string,
	): Result<Row | undefined> =>
		trySync(
			() =>
				db
					.query<Row, [string]>(
						`SELECT * FROM ${physicalTableFor(tbl)} WHERE id = ?`,
					)
					.get(rowId) ?? undefined,
		);

	/**
	 * Every row the FK cascade will remove when task `taskId` is deleted,
	 * children first and the task itself last. Read BEFORE the delete.
	 */
	export const cascadeOf = (db: Db, taskId: string): Result<Cascade> =>
		trySync(() => cascadeOfTask(db, taskId));

	/**
	 * Remove the triggers the trigger-based design installed. Idempotent, cheap,
	 * and load-bearing on any database that predates explicit capture: leaving
	 * them in place would record every write twice.
	 */
	export const dropLegacyTriggers = (db: Db): Result<number> =>
		trySync(() => {
			let dropped = 0;
			for (const logical of SYNC_TABLES) {
				for (const suffix of LEGACY_TRIGGER_SUFFIX) {
					const name = `${tablePrefix()}sync_cap_${logical}_${suffix}`;
					const exists = db
						.query<{ one: number }, [string]>(
							`SELECT 1 AS one FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
						)
						.get(name);
					if (!exists) continue;
					db.run(`DROP TRIGGER IF EXISTS ${name}`);
					dropped++;
				}
			}
			return dropped;
		});

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
					`SELECT device_id, last_pushed_seq, last_applied_seq, last_sync_at, updated_at
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
}
