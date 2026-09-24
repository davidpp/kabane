/**
 * Planner Sync — Conflict Resolution
 *
 * Pure per-table rules: an incoming op plus the local rows the caller already
 * fetched in, one decision out. No `Database` handle, no I/O, no imports from
 * `storage/` — `apply.ts` owns every read and every write. That split is what
 * makes the subtle half of sync testable without a DB.
 *
 * TOTAL, NOT FALLIBLE. Every failure mode (unknown table, missing payload,
 * unparseable `items` JSON) resolves to `skip` with a distinguishable reason
 * rather than an `err`. A `Result` here would let one malformed op from a newer
 * or buggier device wedge `last_applied_seq` forever; a counted skip keeps the
 * watermark moving and still surfaces the op to the caller's report.
 *
 * CLOCKS ARE ROW FIELDS, NOT WALL CLOCKS. Every comparison reads the same
 * column on both sides (`CLOCK_COLUMN`) out of the payload and out of the local
 * row, so the resolver is deterministic and both devices reach the same answer
 * from opposite directions. One tie-break chain applies everywhere: clock, then
 * ULID order, then `version`, then `updated_by`, then `device_id`. All five are
 * orderings the devices agree on without talking. `version` and `updated_by`
 * are what make the chain hold beyond two devices: `device_id` alone stood in
 * for "who wrote this", which is exact for two machines and wrong the moment a
 * third machine's row is compared as if this one had written it.
 *
 * ROW IDENTITY IS THE LOWER ULID. Three tables carry a UNIQUE key separate from
 * their primary key (`task_links`, `task_context_refs`, `upstream_links`), so two
 * devices can mint two ULIDs for one logical row. The lower ULID survives and
 * the decision names the loser in `dropRowId` — without that, `UNIQUE` rejects
 * the second row and the two devices never converge.
 *
 * FK PARENTS ARE CHECKED BEFORE ANYTHING ELSE. Orphans come from concurrency,
 * not from capture: cascaded child deletes ARE captured, children before the
 * parent, so replaying a cascade in `seq` order is FK-safe. The case that is not
 * safe is create-after-delete across devices — B adds a comment on task T while
 * A deletes T, A's delete sits earlier in the log, and B's insert lands on a
 * device where the parent is already gone. With `foreign_keys = ON` that insert
 * fails, and SQLite has rolled the transaction back before any `try/catch` can
 * intervene, taking every legitimate sibling write in the batch with it. Hence a
 * decision, checked first, so the applier can filter orphans out before it
 * executes anything.
 */

import { SYNC_TABLES, type SyncOp, type SyncTable } from "../schemas";

// ============================================================
// Constants
// ============================================================

/**
 * The LWW clock column per table. `task_links` and `task_work_log` rows are
 * immutable once written (no update path exists), so they have no clock and
 * fall back to the op's own capture time.
 */
/**
 * Exported so `backfill.ts` stamps `row_updated_at` from the same column this
 * resolver reads. Two copies of this map would drift the moment a table's clock
 * changes, and the failure would be a silently wrong LWW comparison.
 */
const CLOCK_COLUMN: Partial<Record<SyncTable, string>> = {
	tasks: "updated_at",
	projects: "updated_at",
	task_comments: "updated_at",
	task_context_refs: "added_at",
	upstream_links: "updated_at",
};

/** Tables whose rows carry an FK to `tasks`. Orphan candidates. */
const CHILD_TABLES: readonly SyncTable[] = [
	"task_comments",
	"task_work_log",
	"task_links",
	"task_context_refs",
	"upstream_links",
];

/** How a table resolves. One family per distinct rule, not one per table. */
type Family =
	/** Row LWW on the clock column, keyed by primary key. */
	| "row-lww"
	/** Insert-if-absent on the ULID primary key. Append-only. */
	| "append-only"
	/** Insert-if-absent on a natural key; lower ULID survives a collision. */
	| "natural-key-dedupe"
	/** Upsert on a natural key; lower ULID survives, content is LWW. */
	| "natural-key-lww";

const FAMILY: Record<SyncTable, Family> = {
	tasks: "row-lww",
	projects: "row-lww",
	task_comments: "append-only",
	task_work_log: "append-only",
	task_links: "natural-key-dedupe",
	task_context_refs: "natural-key-lww",
	upstream_links: "natural-key-lww",
};

// ============================================================
// Types
// ============================================================

/** A row snapshot keyed by DB column name, as captured into the oplog. */
type Row = Record<string, unknown>;

/**
 * Why an op was not applied. Every value is countable and reportable — a skip
 * is never silent.
 */
export const SKIP_REASONS = [
	/**
	 * `tbl` is not replicated by this build: a newer device sent a table this
	 * build does not have yet, or an older one sent a table a migration dropped.
	 */
	"unknown-table",
	/** Insert/update with no payload, or an `items` blob that will not parse. */
	"malformed-payload",
	/** LWW: the local version wins. */
	"not-newer",
	/** Append-only row already present under this ULID. */
	"already-present",
	/** A lower-ULID local row already holds this natural key. */
	"duplicate-natural-key",
	/** FK parent absent — the parent delete already happened and is authoritative. */
	"orphan-parent",
	/** The row was deleted and this write is not newer than the delete. */
	"deleted",
	/** Delete for a row that is not here. */
	"already-absent",
	/** Delete loses to a strictly newer local update. */
	"newer-local-update",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * What `apply.ts` must execute. Each kind maps to exactly one SQL action, so
 * the applier never re-derives anything from the op.
 */
export type ResolveDecision =
	/** Write `row` at `rowId`, dropping `dropRowId` first when set. */
	| {
			kind: "apply";
			rowId: string;
			row: Row;
			/** Losing local row holding the same natural key, if any. */
			dropRowId: string | undefined;
	  }
	/**
	 * `short_id` collision. The ULID-earlier row keeps `shortId`; `loserId` gets a
	 * freshly minted label. When `loserId === rowId` the incoming row is the loser
	 * and must be written with that new label instead of the one in `row`.
	 *
	 * `short_id_history` is an audit trail, not a lookup fallback: the winner keeps
	 * the old label live, so nothing can resolve it back to the loser, whose new
	 * label is on its own row — see the `short_id` ruling in
	 * `packages/planner/CLAUDE.md`.
	 */
	| {
			kind: "rename";
			rowId: string;
			row: Row;
			loserId: string;
			shortId: string;
	  }
	/** Delete `rowId`. */
	| { kind: "delete"; rowId: string }
	/** Do nothing, and count it. */
	| { kind: "skip"; reason: SkipReason };

/**
 * Local state the caller looked up for one op. Every field is required so a
 * caller that forgets a lookup fails to compile rather than resolving wrongly.
 */
export type ResolveLocalState = {
	/** Local row whose primary key is `op.rowId`. */
	byId: Row | undefined;
	/**
	 * Local row holding the incoming row's UNIQUE natural key under a DIFFERENT
	 * id: `task_links` UNIQUE(source_id, target_id, type), `task_context_refs`
	 * UNIQUE(task_id, uri), `upstream_links` UNIQUE(task_id, provider,
	 * external_id). `undefined` for tables with no second unique key.
	 */
	byNaturalKey: Row | undefined;
	/**
	 * Local `tasks`/`projects` row holding the incoming row's `short_id` under a
	 * DIFFERENT id. Drives the rename decision.
	 */
	byShortId: Row | undefined;
	/**
	 * Whether EVERY FK parent of the incoming row exists locally (`task_links`
	 * has two). Child tables only; `undefined` means "not checked" and is
	 * treated as present, so a forgotten lookup fails loudly at the FK
	 * constraint instead of silently discarding every child row.
	 */
	parentPresent: boolean | undefined;
	/**
	 * `capturedAt` of the newest delete known for `op.rowId` — applied earlier in
	 * this pass or in a previous one. Sync is tombstone-free, so this is the only
	 * thing that lets a late update to a deleted row be dropped.
	 */
	deletedAt: string | undefined;
	/**
	 * This machine's `device_id` (`Oplog.getState`). The tie-break of last resort
	 * for same-id row LWW, where comparing ULIDs is vacuous: on an exact clock tie
	 * the lower `device_id` wins. Both devices compute the same winner from
	 * opposite directions — `aaa` keeps its own row, `bbb` takes `aaa`'s — so an
	 * identical-millisecond edit on two machines converges instead of each
	 * machine keeping its own version forever.
	 */
	localDeviceId: string;
};

// ============================================================
// Private Helpers
// ============================================================

const asString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const col = (row: Row | undefined, name: string): string | undefined =>
	row === undefined ? undefined : asString(row[name]);

const skip = (reason: SkipReason): ResolveDecision => ({
	kind: "skip",
	reason,
});

const isSyncTable = (tbl: string): tbl is SyncTable =>
	(SYNC_TABLES as readonly string[]).includes(tbl);

/**
 * The op's clock. Deletes carry no payload and clock-less tables carry no
 * `row_updated_at`, so capture time is the floor.
 */
const opClock = (op: SyncOp, table: SyncTable): string => {
	const column = CLOCK_COLUMN[table];
	const fromPayload =
		column === undefined ? undefined : col(op.payload, column);
	return fromPayload ?? op.rowUpdatedAt ?? op.capturedAt;
};

const localClock = (row: Row, table: SyncTable): string | undefined => {
	const column = CLOCK_COLUMN[table];
	return column === undefined ? undefined : col(row, column);
};

/**
 * Clock, then ULID, then version, then actor, then `device_id`. One chain,
 * used by every rule.
 *
 * The ULID step decides rows that two devices minted separately. It is vacuous
 * when both sides carry the same id. On a same-id clock tie the row with more
 * writes behind it wins (`version`), then the lexically lower actor URI, then
 * the lower device id — the last two are arbitrary but agreed, which is all a
 * tie-break has to be. Equal device ids mean the op is a re-delivery of what
 * is already here, so the local side stands.
 *
 * `incoming` and `local` read as "challenger" and "holder" at the item-merge
 * site, where the holder can be either device's row.
 */
const incomingWins = (args: {
	incoming: string;
	local: string | undefined;
	incomingId: string;
	localId: string;
	versions?: { incoming: number | undefined; local: number | undefined };
	actors?: { incoming: string | undefined; local: string | undefined };
	devices: { incoming: string; local: string };
}): boolean => {
	if (args.local === undefined) return true;
	if (args.incoming !== args.local) return args.incoming > args.local;
	if (args.incomingId !== args.localId) return args.incomingId < args.localId;

	const versions = args.versions;
	if (
		versions?.incoming !== undefined &&
		versions.local !== undefined &&
		versions.incoming !== versions.local
	) {
		return versions.incoming > versions.local;
	}

	const actors = args.actors;
	if (
		actors?.incoming !== undefined &&
		actors.local !== undefined &&
		actors.incoming !== actors.local
	) {
		return actors.incoming < actors.local;
	}

	return args.devices.incoming < args.devices.local;
};

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" ? value : undefined;

/** The version/actor pair a same-id comparison reads from each side. */
const lineage = (op: SyncOp, localRow: Row | undefined) => ({
	versions: {
		incoming: asNumber(op.payload?.version),
		local: asNumber(localRow?.version),
	},
	actors: {
		incoming: col(op.payload, "updated_by"),
		local: col(localRow, "updated_by"),
	},
});

/** Ignore a natural-key row that is really the same row `byId` covers. */
const otherRow = (row: Row | undefined, rowId: string): Row | undefined =>
	row !== undefined && col(row, "id") !== rowId ? row : undefined;

const lower = (a: string, b: string): string => (a < b ? a : b);

// ============================================================
// Per-family Resolution
// ============================================================

type WriteArgs = {
	table: SyncTable;
	op: SyncOp;
	payload: Row;
	local: ResolveLocalState;
};

const resolveRowLww = ({
	table,
	op,
	payload,
	local,
}: WriteArgs): ResolveDecision => {
	if (
		local.byId !== undefined &&
		!incomingWins({
			incoming: opClock(op, table),
			local: localClock(local.byId, table),
			incomingId: op.rowId,
			localId: col(local.byId, "id") ?? op.rowId,
			...lineage(op, local.byId),
			devices: { incoming: op.deviceId, local: local.localDeviceId },
		})
	) {
		return skip("not-newer");
	}

	// A different local row already holds this label. The ULID-earlier row keeps
	// it; both devices pick the same winner without talking to each other.
	const contested = col(payload, "short_id");
	const holder = otherRow(local.byShortId, op.rowId);
	const holderId = col(holder, "id");
	if (contested !== undefined && holderId !== undefined) {
		return {
			kind: "rename",
			rowId: op.rowId,
			row: payload,
			loserId: holderId < op.rowId ? op.rowId : holderId,
			shortId: contested,
		};
	}

	return { kind: "apply", rowId: op.rowId, row: payload, dropRowId: undefined };
};

const resolveAppendOnly = ({
	op,
	payload,
	local,
}: WriteArgs): ResolveDecision =>
	local.byId !== undefined
		? skip("already-present")
		: { kind: "apply", rowId: op.rowId, row: payload, dropRowId: undefined };

const resolveNaturalKeyDedupe = ({
	op,
	payload,
	local,
}: WriteArgs): ResolveDecision => {
	if (local.byId !== undefined) return skip("already-present");

	const holder = otherRow(local.byNaturalKey, op.rowId);
	const holderId = col(holder, "id");
	if (holderId !== undefined && holderId < op.rowId) {
		return skip("duplicate-natural-key");
	}

	return { kind: "apply", rowId: op.rowId, row: payload, dropRowId: holderId };
};

const resolveNaturalKeyLww = ({
	table,
	op,
	payload,
	local,
}: WriteArgs): ResolveDecision => {
	const holder = otherRow(local.byNaturalKey, op.rowId);
	const localRow = local.byId ?? holder;
	if (localRow === undefined) {
		return {
			kind: "apply",
			rowId: op.rowId,
			row: payload,
			dropRowId: undefined,
		};
	}

	const localId = col(localRow, "id") ?? op.rowId;
	const winnerId = lower(op.rowId, localId);
	const takesIncoming = incomingWins({
		incoming: opClock(op, table),
		local: localClock(localRow, table),
		incomingId: op.rowId,
		localId,
		...lineage(op, localRow),
		devices: { incoming: op.deviceId, local: local.localDeviceId },
	});

	// Nothing to do only when the surviving row is already the local one AND its
	// content wins. Otherwise the winning content has to be rewritten under the
	// winning id.
	if (!takesIncoming && winnerId === localId) return skip("not-newer");

	return {
		kind: "apply",
		rowId: winnerId,
		row: { ...(takesIncoming ? payload : localRow), id: winnerId },
		dropRowId:
			holder !== undefined && localId !== winnerId ? localId : undefined,
	};
};

const RESOLVERS: Record<Family, (args: WriteArgs) => ResolveDecision> = {
	"row-lww": resolveRowLww,
	"append-only": resolveAppendOnly,
	"natural-key-dedupe": resolveNaturalKeyDedupe,
	"natural-key-lww": resolveNaturalKeyLww,
};

const resolveDelete = (
	table: SyncTable,
	op: SyncOp,
	local: ResolveLocalState,
): ResolveDecision => {
	if (local.byId === undefined) return skip("already-absent");

	const held = localClock(local.byId, table);
	if (held !== undefined && held > opClock(op, table)) {
		return skip("newer-local-update");
	}

	return { kind: "delete", rowId: op.rowId };
};

// ============================================================
// Resolve Namespace
// ============================================================

export namespace Resolve {
	/**
	 * Decide what one incoming op does to local state.
	 *
	 * Total by construction: unknown tables and malformed payloads come back as
	 * `skip`, so the caller can always advance its watermark.
	 */
	export const decide = (
		op: SyncOp,
		local: ResolveLocalState,
	): ResolveDecision => {
		if (!isSyncTable(op.tbl)) return skip("unknown-table");
		const table = op.tbl;

		if (op.op === "delete") return resolveDelete(table, op, local);

		const payload = op.payload;
		if (payload === undefined) return skip("malformed-payload");

		// First: the parent was deleted on another device, and an orphan insert
		// aborts the whole apply transaction rather than just itself.
		if (local.parentPresent === false && CHILD_TABLES.includes(table)) {
			return skip("orphan-parent");
		}

		// Tombstone-free, so a known delete is the only evidence that an absent
		// row was deleted rather than never seen.
		if (
			local.byId === undefined &&
			local.deletedAt !== undefined &&
			!(opClock(op, table) > local.deletedAt)
		) {
			return skip("deleted");
		}

		return RESOLVERS[FAMILY[table]]({ table, op, payload, local });
	};
}
