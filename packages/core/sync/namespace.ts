/**
 * Planner Sync — Entry Points
 *
 * `push`, `pull`, `status` — the three operations every surface (CLI, tRPC,
 * hook, scheduled workflow) calls, and the only functions here carrying
 * `traced()`. They orchestrate; the leaf helpers under them stay untraced so a
 * sync pass produces three readable spans instead of one per op.
 *
 * A TRANSPORT IS A PARAMETER, never a module-level singleton. That is what lets
 * the same code path run against an in-process relay in a test and a Worker in
 * production without a branch anywhere in this file.
 *
 * FAILURE IS ORDINARY. Every path returns `Result` and none throws: sync runs
 * from a Stop hook and an hourly workflow, and a sync failure must never block
 * or fail a planner write.
 */

import type { Db } from "../db/port";
import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";

import type { SyncStatus } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Migrations } from "../storage/migrations";
import { Oplog } from "../storage/oplog";
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
 * Quarantined ops listed in `status`. The count beside them is the true total —
 * this bounds an MCP tool's output when something has gone badly wrong.
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
 * The first op this build cannot store: one pushed by a kabane with a newer
 * schema. Applying it would drop the columns this build lacks (apply writes only
 * the columns it knows) or skip a table it has never heard of, and the watermark
 * would move past it for good.
 */
const firstNewerOp = (ops: readonly RelayOp[]): RelayOp | undefined =>
	ops.find((op) => (op.schema ?? BASELINE_SCHEMA) > Migrations.SCHEMA_VERSION);

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

		// The local `seq` is meaningless to the log — strip it at the seam. The
		// schema version goes on instead, so an older device knows to stop.
		const ack = await transport.push(
			ops.map(({ seq: _seq, ...op }) => ({
				...op,
				schema: Migrations.SCHEMA_VERSION,
			})),
		);
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

	let total = Apply.emptyReport(state.value.lastAppliedSeq);
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
