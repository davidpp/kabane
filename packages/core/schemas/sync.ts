/**
 * Sync Schemas
 *
 * Contracts for replicating planner state between machines. The local
 * `bun:sqlite` stays authoritative; capture triggers append row snapshots to
 * `planner_sync_oplog`, and a sync pass ships those ops to a remote log that
 * assigns a total order.
 *
 * `tbl` and `op` stay soft strings on the wire (house style) with
 * SYNC_TABLES / SyncOpKindSchema as the known-value sets, so a newer device
 * can send a table this build has never heard of without failing the parse.
 */

// plain zod (not zui): must compose into the router's plain-zod
// discriminatedUnion — see JJAK-959 quality ruling.
import { z } from "zod";

/**
 * Base tables that replicate.
 *
 * Deliberately excluded: `task_activity` (high-volume audit trail),
 * `agent_sessions` / `agent_activities` (machine-local agent runs),
 * `proposals` (retired surface, drop pending), `sequences` (local counter),
 * and `upstream_links` (documented machine-private invariant).
 */
export const SYNC_TABLES = [
	"tasks",
	"task_links",
	"focus_lists",
	"task_comments",
	"task_work_log",
	"projects",
	"task_context_refs",
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** The three row mutations capture records. */
export const SyncOpKindSchema = z.enum(["insert", "update", "delete"]);
export type SyncOpKind = z.infer<typeof SyncOpKindSchema>;

/**
 * One captured row mutation — the unit of replication.
 */
export const SyncOpSchema = z.object({
	/** Idempotency key, minted at capture time. Unique per op, forever. */
	opId: z.string(),

	/** Device that captured the op. A device skips its own ops on pull. */
	deviceId: z.string(),

	/** Logical (unprefixed) table name, e.g. "tasks" */
	tbl: z.string(),

	/** Primary key of the mutated row */
	rowId: z.string(),

	/** insert | update | delete (soft string on the wire) */
	op: SyncOpKindSchema,

	/** LWW clock. Absent for deletes and for tables with no `updated_at`. */
	rowUpdatedAt: z.string().optional(),

	/** Full row snapshot keyed by DB column name. Absent for deletes. */
	payload: z.record(z.unknown()).optional(),

	/** When capture fired (ISO timestamp) */
	capturedAt: z.string(),
});
export type SyncOp = z.infer<typeof SyncOpSchema>;

/**
 * An op the remote refuses and the local device has given up on.
 *
 * The alternative to recording these is a silent permanent stall: the remote
 * batch is atomic, so one op it will never accept fails every retry that
 * includes it, forever. Skipping the op keeps the watermark moving; this row is
 * what keeps the skip from being invisible.
 */
export const QuarantinedOpSchema = z.object({
	/** The op's idempotency key. Its row is still in `planner_sync_oplog`. */
	opId: z.string(),

	/** Logical table and row the op carried, for finding what did not replicate. */
	tbl: z.string(),
	rowId: z.string(),

	/** Serialized size of the op. The usual cause of a refusal. */
	bytes: z.number(),

	/** What the remote said, verbatim. */
	reason: z.string(),

	quarantinedAt: z.string(),
});
export type QuarantinedOp = z.infer<typeof QuarantinedOpSchema>;

/**
 * Replication health, as surfaced to humans and agents. `pendingOps` is the
 * useful number: it says how far this machine is behind.
 */
export const SyncStatusSchema = z.object({
	/** Whether sync is configured and turned on */
	enabled: z.boolean(),

	/** This machine's stable device identifier */
	deviceId: z.string(),

	/** Captured ops not yet acked as pushed */
	pendingOps: z.number(),

	/** Local oplog watermark: everything at or below this has been pushed */
	lastPushedSeq: z.number(),

	/** Remote watermark: everything at or below this has been applied locally */
	lastAppliedSeq: z.number(),

	/** Last successful sync pass (ISO timestamp) */
	lastSyncAt: z.string().optional(),

	/** Short IDs repaired by the rename protocol */
	renamedShortIds: z.number(),

	/** Ops the remote refused and this device stopped retrying. Normally 0. */
	quarantinedOps: z.number(),

	/**
	 * The most recent quarantined ops, newest first. Capped — the count above is
	 * the true total, this is the detail a human needs to go look at a row.
	 */
	quarantined: z.array(QuarantinedOpSchema),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
