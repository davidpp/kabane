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
 * ULID order, then `device_id` for the same-id case where ULIDs are equal by
 * definition. All three are orderings the devices agree on without talking.
 *
 * ROW IDENTITY IS THE LOWER ULID. Three tables carry a UNIQUE key separate from
 * their primary key (`task_links`, `task_context_refs`, `focus_lists`), so two
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

// plain zod (not zui): domain-side parsing, and zui cannot compose into the
// router's plain-zod schemas — see JJAK-959.
import { z } from "zod";
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
export const CLOCK_COLUMN: Partial<Record<SyncTable, string>> = {
	tasks: "updated_at",
	projects: "updated_at",
	focus_lists: "updated_at",
	task_comments: "updated_at",
	task_context_refs: "added_at",
};

/** Tables whose rows carry an FK to `tasks`. Orphan candidates. */
const CHILD_TABLES: readonly SyncTable[] = [
	"task_comments",
	"task_work_log",
	"task_links",
	"task_context_refs",
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
	| "natural-key-lww"
	/** Lowest ULID owns the row; `items` merge instead of replace. */
	| "focus-list";

const FAMILY: Record<SyncTable, Family> = {
	tasks: "row-lww",
	projects: "row-lww",
	task_comments: "append-only",
	task_work_log: "append-only",
	task_links: "natural-key-dedupe",
	task_context_refs: "natural-key-lww",
	focus_lists: "focus-list",
};

/** `items` is opaque TEXT: a JSON array of objects with unknown extra fields. */
const FocusItemsSchema = z.array(z.record(z.unknown()));

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
	/** `tbl` is not replicated by this build. A newer device sent it. */
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
	/** Same as `apply`, but `row` is a field/item merge of both sides. */
	| {
			kind: "merge";
			rowId: string;
			row: Row;
			dropRowId: string | undefined;
	  }
	/**
	 * `short_id` collision. The ULID-earlier row keeps `shortId`; `loserId` gets a
	 * freshly minted label. When `loserId === rowId` the incoming row is the loser
	 * and must be written with that new label instead of the one in `row`.
	 *
	 * `short_id_history` is an audit trail, not a lookup fallback: the winner keeps
	 * the old label live, so nothing can resolve it back to the loser. The rename
	 * must land visibly on the renamed task instead — see the `short_id` ruling in
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
	 * UNIQUE(task_id, uri), `focus_lists` UNIQUE(period). `undefined` for tables
	 * with no second unique key.
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
 * Clock, then ULID, then `device_id`. One chain, used by every rule.
 *
 * The ULID step decides rows that two devices minted separately. It is vacuous
 * when both sides carry the same id, and the device step is what stops those
 * from diverging forever: without it an identical-millisecond edit on two
 * machines leaves each holding its own content. Equal device ids mean the op is
 * a re-delivery of what is already here, so the local side stands.
 *
 * `incoming` and `local` read as "challenger" and "holder" at the item-merge
 * site, where the holder can be either device's row.
 */
const incomingWins = (args: {
	incoming: string;
	local: string | undefined;
	incomingId: string;
	localId: string;
	devices: { incoming: string; local: string };
}): boolean => {
	if (args.local === undefined) return true;
	if (args.incoming !== args.local) return args.incoming > args.local;
	if (args.incomingId !== args.localId) return args.incomingId < args.localId;
	return args.devices.incoming < args.devices.local;
};

/** Ignore a natural-key row that is really the same row `byId` covers. */
const otherRow = (row: Row | undefined, rowId: string): Row | undefined =>
	row !== undefined && col(row, "id") !== rowId ? row : undefined;

const lower = (a: string, b: string): string => (a < b ? a : b);

const earliest = (
	a: string | undefined,
	b: string | undefined,
): string | undefined => {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return lower(a, b);
};

const latest = (a: string, b: string | undefined): string =>
	b === undefined || a > b ? a : b;

/** `undefined` means not JSON — a valid document can never decode to it. */
const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
};

/** `[]` for an absent column; `undefined` means the blob is unusable. */
const parseFocusItems = (raw: unknown): Row[] | undefined => {
	if (raw === undefined || raw === null) return [];
	const text = asString(raw);
	if (text === undefined) return undefined;

	const decoded = parseJson(text);
	if (decoded === undefined) return undefined;

	const parsed = FocusItemsSchema.safeParse(decoded);
	return parsed.success ? parsed.data : undefined;
};

/**
 * `taskId` is the item key the focus-list schema already enforces as unique.
 * Items without one keep their identity by value so a merge cannot duplicate
 * them.
 */
const itemKey = (item: Row): string =>
	col(item, "taskId") ?? JSON.stringify(item);

/**
 * Per-item clock. `FocusItem` has no `updatedAt`, so `completedAt` is the only
 * timestamp an item owns and an untouched item inherits its row's clock. Item
 * accuracy is therefore bounded by row granularity — the union of items is what
 * this rule guarantees.
 */
const itemClock = (item: Row, rowClock: string): string =>
	col(item, "completedAt") ?? rowClock;

const itemOrder = (item: Row): number =>
	typeof item.order === "number" ? item.order : Number.MAX_SAFE_INTEGER;

/** Canonical array order, so both devices serialize byte-identical `items`. */
const byOrderThenKey = (left: Row, right: Row): number =>
	itemOrder(left) - itemOrder(right) ||
	(itemKey(left) < itemKey(right) ? -1 : 1);

type ItemSide = { items: Row[]; clock: string; id: string; device: string };

/**
 * Union by item key with per-item LWW. Both devices see the same two sides and
 * the comparator is total, so the merge is commutative.
 *
 * `device` matters when both sides are the same row — the two devices edited one
 * already-replicated focus list — because then the ULID step cannot separate
 * them and two same-millisecond item edits would each survive only locally.
 */
const mergeFocusItems = (a: ItemSide, b: ItemSide): Row[] => {
	type Held = { item: Row; clock: string; id: string; device: string };
	const merged = new Map<string, Held>();

	for (const side of [a, b]) {
		for (const item of side.items) {
			const key = itemKey(item);
			const clock = itemClock(item, side.clock);
			const held = merged.get(key);
			const takes =
				held === undefined ||
				incomingWins({
					incoming: clock,
					local: held.clock,
					incomingId: side.id,
					localId: held.id,
					devices: { incoming: side.device, local: held.device },
				});
			if (takes) {
				merged.set(key, { item, clock, id: side.id, device: side.device });
			}
		}
	}

	return [...merged.values()].map((entry) => entry.item).sort(byOrderThenKey);
};

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

const resolveFocusList = ({
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

	const incomingItems = parseFocusItems(payload.items);
	const localItems = parseFocusItems(localRow.items);
	if (incomingItems === undefined || localItems === undefined) {
		return skip("malformed-payload");
	}

	const localId = col(localRow, "id") ?? op.rowId;
	const winnerId = lower(op.rowId, localId);
	const incoming = opClock(op, table);
	const held = localClock(localRow, table);

	// theme, reflection, and any column a newer device added ride along with the
	// row-LWW winner. `items` never does — replacing them is the data loss this
	// whole rule exists to prevent.
	const base = incomingWins({
		incoming,
		local: held,
		incomingId: op.rowId,
		localId,
		devices: { incoming: op.deviceId, local: local.localDeviceId },
	})
		? payload
		: localRow;

	const items = mergeFocusItems(
		{
			items: incomingItems,
			clock: incoming,
			id: op.rowId,
			device: op.deviceId,
		},
		{
			items: localItems,
			clock: held ?? incoming,
			id: localId,
			device: local.localDeviceId,
		},
	);
	const createdAt = earliest(
		col(payload, "created_at"),
		col(localRow, "created_at"),
	);

	return {
		kind: "merge",
		rowId: winnerId,
		row: {
			...base,
			id: winnerId,
			items: JSON.stringify(items),
			updated_at: latest(incoming, held),
			...(createdAt === undefined ? {} : { created_at: createdAt }),
		},
		dropRowId:
			holder !== undefined && localId !== winnerId ? localId : undefined,
	};
};

const RESOLVERS: Record<Family, (args: WriteArgs) => ResolveDecision> = {
	"row-lww": resolveRowLww,
	"append-only": resolveAppendOnly,
	"natural-key-dedupe": resolveNaturalKeyDedupe,
	"natural-key-lww": resolveNaturalKeyLww,
	"focus-list": resolveFocusList,
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
