/**
 * Planner Sync — Entry Points
 *
 * `push`, `pull`, `status` — the three operations every surface (the CLI, a
 * scheduled pull) calls, and the only functions here carrying
 * `traced()`. They orchestrate; the leaf helpers under them stay untraced so a
 * sync pass produces three readable spans instead of one per op.
 *
 * A TRANSPORT IS A PARAMETER, never a module-level singleton. That is what lets
 * the same code path run against an in-process relay in a test and a Worker in
 * production without a branch anywhere in this file.
 *
 * FAILURE IS ORDINARY. Every path returns `Result` and none throws: sync runs
 * unattended on a schedule, and a sync failure must never block
 * or fail a planner write.
 */

import type { Db } from "../db/port";
import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";

import type { ParkedFailure, SyncOp, SyncStatus } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Migrations } from "../storage/migrations";
import { type DrainedOp, Oplog } from "../storage/oplog";
import { Apply, type ApplyReport } from "./apply";
import type { PullPage, RelayOp, SyncTransport } from "./transport";

// ============================================================
// Constants
// ============================================================

/** Ops per push or pull. Slice 2 sizes real chunks by bytes; this is a count. */
const DEFAULT_BATCH = 500;

/**
 * Pages per pass. A bound, not a limit on catching up — an unbounded loop
 * against a log another device is actively writing would never return.
 */
const DEFAULT_MAX_BATCHES = 100;

/** The schema an op without a `schema` field was pushed by: before the field, the baseline. */
const BASELINE_SCHEMA = 1;

/**
 * Quarantined ops, and parked ops whose replay failed, listed in `status`. The
 * count beside each is the true total — this bounds an MCP tool's output when
 * something has gone badly wrong.
 */
const QUARANTINE_DETAIL_LIMIT = 10;

// ============================================================
// Types
// ============================================================

export type SyncOpts = {
	/** Ops per batch (default 500). */
	limit?: number;
	/** Batches per pass (default 100). */
	maxBatches?: number;
};

export type PushResult = {
	/** Ops the log accepted. */
	pushed: number;
	/** Ops the log already had under the same `opId`. A retry, not an error. */
	duplicates: number;
	/** Local `seq` the pushed watermark advanced to. */
	throughSeq: number;
	batches: number;
};

export type PullResult = ApplyReport & { batches: number };

// ============================================================
// Private Helpers
// ============================================================

/** `withDb` around a function that already returns `Result`, flattened. */
const inDb = async <T>(
	basePath: string,
	fn: (db: Db) => Result<T>,
): Promise<Result<T>> => {
	const outer = await withDb(basePath, fn);
	return outer.ok ? outer.value : outer;
};

const notInitialized = (): Error =>
	new Error(
		"Sync is not initialized on this device. Call Oplog.initDevice first.",
	);

/**
 * Stamp a successful pass. `Oplog` owns the rest of the singleton row; this one
 * column is the pass's own outcome, so it is written where the pass runs.
 */
const touchSyncedAt = (basePath: string): Promise<Result<void>> =>
	inDb(basePath, (db) => {
		const now = new Date().toISOString();
		db.run(
			`UPDATE ${TABLES.sync_state} SET last_sync_at = ?, updated_at = ? WHERE id = 'local'`,
			[now, now],
		);
		return ok(undefined);
	});

const pendingOps = (db: Db): number =>
	db
		.query<{ count: number }, []>(
			`SELECT COUNT(*) AS count FROM ${TABLES.sync_oplog}
        WHERE seq > (SELECT last_pushed_seq FROM ${TABLES.sync_state} WHERE id = 'local')`,
		)
		.get()?.count ?? 0;

/**
 * The first core op this build cannot store: one pushed by a kabane with a
 * newer schema. Applying it would drop the columns this build lacks (apply
 * writes only the columns it knows) or skip a table it has never heard of, and
 * the watermark would move past it for good. A data module's op never stops
 * the pull: apply parks the ones this device cannot read yet.
 */
const firstNewerOp = (ops: readonly RelayOp[]): RelayOp | undefined =>
	ops.find(
		(op) =>
			op.module === undefined &&
			(op.schema ?? BASELINE_SCHEMA) > Migrations.SCHEMA_VERSION,
	);

/** The part of a page before `op`, with the watermark stopping just short of it. */
const pageBefore = (page: PullPage, op: RelayOp): PullPage => ({
	ops: page.ops.filter((o) => o.serverSeq < op.serverSeq),
	throughSeq: op.serverSeq - 1,
	hasMore: true,
});

const schemaAhead = (op: RelayOp): Error =>
	new Error(
		`the sync log holds a change from a newer kabane (schema ${op.schema}; this device runs schema ${Migrations.SCHEMA_VERSION}). Update kabane on this device and sync again: the pull stopped before that change, at server seq ${op.serverSeq}, and skipped nothing.`,
	);

/** Parked ops per module name. */
const parkedOps = (db: Db): Record<string, number> =>
	Object.fromEntries(
		db
			.query<{ module: string; count: number }, []>(
				`SELECT module, COUNT(*) AS count FROM ${TABLES.sync_parked}
          GROUP BY module ORDER BY module`,
			)
			.all()
			.map((row) => [row.module, row.count]),
	);

const parkedFailures = (db: Db): number =>
	db
		.query<{ count: number }, []>(
			`SELECT COUNT(*) AS count FROM ${TABLES.sync_parked} WHERE error IS NOT NULL`,
		)
		.get()?.count ?? 0;

/** Parked ops whose replay failed, newest first. */
const parkedFailed = (db: Db, limit: number): ParkedFailure[] =>
	db
		.query<
			{
				op_id: string;
				module: string;
				tbl: string;
				row_id: string;
				error: string;
				failed_at: string;
			},
			[number]
		>(
			`SELECT op_id, module, tbl, row_id, error, failed_at FROM ${TABLES.sync_parked}
        WHERE error IS NOT NULL
        ORDER BY failed_at DESC, op_id DESC
        LIMIT ?`,
		)
		.all(limit)
		.map((row) => ({
			opId: row.op_id,
			module: row.module,
			tbl: row.tbl,
			rowId: row.row_id,
			error: row.error,
			failedAt: row.failed_at,
		}));

/**
 * An op as it goes on the wire: core's schema version on every op, so an older
 * device knows to stop. A module table's op already carries its module tag,
 * set at capture (`Oplog.snapshotOp`), so a device without that module parks
 * it whatever this build has registered now.
 */
const outgoing = ({ seq: _seq, ...op }: DrainedOp): SyncOp => ({
	...op,
	schema: Migrations.SCHEMA_VERSION,
});

const renamedShortIds = (db: Db): number =>
	db
		.query<{ count: number }, []>(
			`SELECT COUNT(*) AS count FROM ${TABLES.short_id_history}`,
		)
		.get()?.count ?? 0;

// ============================================================
// Implementations
// ============================================================

const pushImpl = async (
	basePath: string,
	transport: SyncTransport,
	opts: SyncOpts = {},
): Promise<Result<PushResult>> => {
	const limit = opts.limit ?? DEFAULT_BATCH;
	const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;

	const state = await inDb(basePath, Oplog.getState);
	if (!state.ok) return state;
	if (state.value === undefined) return err(notInitialized());

	let pushed = 0;
	let duplicates = 0;
	let throughSeq = state.value.lastPushedSeq;
	let batches = 0;

	for (let batch = 0; batch < maxBatches; batch++) {
		const drained = await inDb(basePath, (db) => Oplog.drain(db, limit));
		if (!drained.ok) return drained;
		const ops = drained.value;
		if (ops.length === 0) break;

		// The local `seq` is meaningless to the log — strip it at the seam.
		const ack = await transport.push(ops.map(outgoing));
		if (!ack.ok) return ack;

		const last = ops[ops.length - 1];
		if (last === undefined) break;

		const acked = await inDb(basePath, (db) => Oplog.ack(db, last.seq));
		if (!acked.ok) return acked;

		pushed += ack.value.accepted;
		duplicates += ack.value.duplicates;
		throughSeq = last.seq;
		batches++;

		if (ops.length < limit) break;
	}

	if (batches > 0) {
		const stamped = await touchSyncedAt(basePath);
		if (!stamped.ok) return stamped;
	}

	return ok({ pushed, duplicates, throughSeq, batches });
};

const pullImpl = async (
	basePath: string,
	transport: SyncTransport,
	opts: SyncOpts = {},
): Promise<Result<PullResult>> => {
	const limit = opts.limit ?? DEFAULT_BATCH;
	const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;

	const state = await inDb(basePath, Oplog.getState);
	if (!state.ok) return state;
	if (state.value === undefined) return err(notInitialized());

	// Ops parked for a module that has registered or migrated since apply
	// first, in log order, before anything newer lands on top of them.
	const replayed = await Apply.replayParked(basePath);
	if (!replayed.ok) return replayed;

	let total = Apply.mergeReports(
		Apply.emptyReport(state.value.lastAppliedSeq),
		replayed.value,
	);
	let batches = 0;

	for (let batch = 0; batch < maxBatches; batch++) {
		const page = await transport.pull(total.throughSeq, limit);
		if (!page.ok) return page;

		// An op from a newer schema ends the pull: what comes before it applies,
		// the watermark stops just short of it, and the next pull (after an
		// update) starts there, so nothing is skipped.
		const newer = firstNewerOp(page.value.ops);
		const applicable =
			newer === undefined ? page.value : pageBefore(page.value, newer);

		// A page can be empty and still move the cursor: everything in its window
		// was this device's own work.
		if (
			applicable.ops.length === 0 &&
			applicable.throughSeq <= total.throughSeq
		) {
			if (newer !== undefined) return err(schemaAhead(newer));
			break;
		}

		const report = await Apply.applyBatch(basePath, applicable);
		if (!report.ok) return report;

		total = Apply.mergeReports(total, report.value);
		batches++;

		if (newer !== undefined) return err(schemaAhead(newer));
		if (!applicable.hasMore) break;
	}

	if (batches > 0) {
		const stamped = await touchSyncedAt(basePath);
		if (!stamped.ok) return stamped;
	}

	return ok({ ...total, batches });
};

const statusImpl = async (basePath: string): Promise<Result<SyncStatus>> =>
	inDb<SyncStatus>(basePath, (db) => {
		const state = Oplog.getState(db);
		if (!state.ok) return state;

		// No state row means capture was never armed. Reported as disabled rather
		// than as an error — status is exactly what you call to find that out.
		if (state.value === undefined) {
			return ok({
				enabled: false,
				deviceId: "",
				pendingOps: 0,
				lastPushedSeq: 0,
				lastAppliedSeq: 0,
				renamedShortIds: 0,
				quarantinedOps: 0,
				quarantined: [],
				parkedOps: {},
				parkedFailures: 0,
				parkedFailed: [],
			});
		}

		// Quarantine is the one number here a human has to act on: those ops were
		// skipped to keep the watermark moving and will not retry themselves.
		const quarantinedOps = Oplog.quarantineCount(db);
		if (!quarantinedOps.ok) return quarantinedOps;
		const quarantined = Oplog.listQuarantined(db, QUARANTINE_DETAIL_LIMIT);
		if (!quarantined.ok) return quarantined;

		return ok({
			enabled: true,
			deviceId: state.value.deviceId,
			pendingOps: pendingOps(db),
			lastPushedSeq: state.value.lastPushedSeq,
			lastAppliedSeq: state.value.lastAppliedSeq,
			lastSyncAt: state.value.lastSyncAt,
			renamedShortIds: renamedShortIds(db),
			quarantinedOps: quarantinedOps.value,
			quarantined: quarantined.value,
			parkedOps: parkedOps(db),
			parkedFailures: parkedFailures(db),
			parkedFailed: parkedFailed(db, QUARANTINE_DETAIL_LIMIT),
		});
	});

// ============================================================
// Sync Namespace
// ============================================================

export namespace Sync {
	/** Ship captured local ops to the shared log and advance the pushed watermark. */
	export const push = traced("planner.sync.push", pushImpl, {
		resultAttrs: (result) => ({
			"sync.pushed": result.pushed,
			"sync.duplicates": result.duplicates,
			"sync.batches": result.batches,
		}),
	});

	/** Read everything newer than the applied watermark and write it locally. */
	export const pull = traced("planner.sync.pull", pullImpl, {
		resultAttrs: (result) => ({
			"sync.received": result.received,
			"sync.applied": result.applied,
			"sync.renamed": result.renamed,
			"sync.parked": result.parked,
			"sync.replayed": result.replayed,
			"sync.replay_failed": result.replayFailed,
			"sync.batches": result.batches,
		}),
	});

	/** Replication health. `pendingOps` is how far behind this machine is. */
	export const status = traced("planner.sync.status", statusImpl, {
		attrs: (basePath) => ({ "sync.base_path": basePath }),
		resultAttrs: (result) => ({
			"sync.enabled": result.enabled,
			"sync.pending_ops": result.pendingOps,
			"sync.quarantined_ops": result.quarantinedOps,
		}),
	});
}
