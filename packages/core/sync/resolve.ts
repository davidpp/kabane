/**
 * Planner Sync — Conflict Resolution
 *
 * Pure per-table rules: an incoming op plus the local rows the caller already
 * fetched in, one decision out. No `Database` handle, no I/O, no imports from
 * `storage/` — `apply.ts` owns every read and every write. That split is what
 * makes the subtle half of sync testable without a DB. A module table's rule
 * comes from the module registry (`module.ts`), configuration set once at boot.
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
 *
 * THE 2.0 RECORD (`threads`, `entries`, `attributes`, `links`, `refs`) RESOLVES
 * BY ITS SHAPE INSTEAD, with none of the above: no orphan, no delete evidence,
 * no natural key, no receiving device. Each row is one or more registers, and
 * a register keeps whichever of two values is greater by its clock, then its
 * counter, then its writing device, then its content: a total order read only
 * from the two rows, so the same rows in any order, any number of times, end
 * as the same row (`Resolve.decideRecord`).
 */

import { Modules } from "../module";
import {
	isKeyedTable,
	RECORD_ROW_SCHEMAS,
	RecordId,
	type RecordTable,
	SYNC_TABLES,
	type SyncOp,
	type SyncTable,
} from "../schemas";

// ============================================================
// Constants
// ============================================================

/**
 * The LWW clock column per core table. `task_links` and `task_work_log` rows
 * are immutable once written (no update path exists), so they have no clock and
 * fall back to the op's own capture time. A module table declares its own.
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
export type SyncFamily =
	/** Row LWW on the clock column, keyed by primary key. */
	| "row-lww"
	/** Insert-if-absent on the ULID primary key. Append-only. */
	| "append-only"
	/** Insert-if-absent on a natural key; lower ULID survives a collision. */
	| "natural-key-dedupe"
	/** Upsert on a natural key; lower ULID survives, content is LWW. */
	| "natural-key-lww";

const FAMILY: Record<SyncTable, SyncFamily> = {
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

/**
 * How one replicated table resolves: core's records for a core table, the
 * registry for a module's. Every rule below reads this, so no family logic is
 * written twice.
 */
type TableRule = {
	family: SyncFamily;
	/** LWW clock column; undefined falls back to the op's capture time. */
	clock: string | undefined;
	/** Holds an FK to `tasks`, so an op whose task is gone is an orphan. */
	childOfTasks: boolean;
};

/** A row snapshot keyed by DB column name, as captured into the oplog. */
type Row = Record<string, unknown>;

/**
 * Why an op was not applied. Every value is countable and reportable — a skip
 * is never silent.
 */
export const SKIP_REASONS = [
	/**
	 * `tbl` is no core table and no registered module's: an older device sent a
	 * table a migration dropped. A module's op never lands here while its module
	 * is missing or behind; apply parks it first.
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
	/**
	 * A record attribute, link or ref whose id is not the one its key derives
	 * (`RecordId`), in the envelope or the row: storing it would make a second
	 * row for one key.
	 */
	"key-id-mismatch",
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
	 * `packages/core/AGENTS.md`.
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

const skip = (
	reason: SkipReason,
): Extract<ResolveDecision, { kind: "skip" }> => ({
	kind: "skip",
	reason,
});

const isSyncTable = (tbl: string): tbl is SyncTable =>
	(SYNC_TABLES as readonly string[]).includes(tbl);

/** Core's records first, then the registered modules'. */
const ruleFor = (tbl: string): TableRule | undefined => {
	if (isSyncTable(tbl))
		return {
			family: FAMILY[tbl],
			clock: CLOCK_COLUMN[tbl],
			childOfTasks: CHILD_TABLES.includes(tbl),
		};
	const spec = Modules.table(tbl)?.spec;
	return spec === undefined
		? undefined
		: {
				family: spec.family,
				clock: spec.clock,
				childOfTasks: spec.childOfTasks,
			};
};

/**
 * The op's clock. Deletes carry no payload and clock-less tables carry no
 * `row_updated_at`, so capture time is the floor.
 */
const opClock = (op: SyncOp, rule: TableRule): string => {
	const fromPayload =
		rule.clock === undefined ? undefined : col(op.payload, rule.clock);
	return fromPayload ?? op.rowUpdatedAt ?? op.capturedAt;
};

const localClock = (row: Row, rule: TableRule): string | undefined =>
	rule.clock === undefined ? undefined : col(row, rule.clock);

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
	rule: TableRule;
	op: SyncOp;
	payload: Row;
	local: ResolveLocalState;
};

const resolveRowLww = ({
	rule,
	op,
	payload,
	local,
}: WriteArgs): ResolveDecision => {
	if (
		local.byId !== undefined &&
		!incomingWins({
			incoming: opClock(op, rule),
			local: localClock(local.byId, rule),
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
	rule,
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
		incoming: opClock(op, rule),
		local: localClock(localRow, rule),
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

const RESOLVERS: Record<SyncFamily, (args: WriteArgs) => ResolveDecision> = {
	"row-lww": resolveRowLww,
	"append-only": resolveAppendOnly,
	"natural-key-dedupe": resolveNaturalKeyDedupe,
	"natural-key-lww": resolveNaturalKeyLww,
};

const resolveDelete = (
	rule: TableRule,
	op: SyncOp,
	local: ResolveLocalState,
): ResolveDecision => {
	if (local.byId === undefined) return skip("already-absent");

	const held = localClock(local.byId, rule);
	if (held !== undefined && held > opClock(op, rule)) {
		return skip("newer-local-update");
	}

	return { kind: "delete", rowId: op.rowId };
};

// ============================================================
// The 2.0 record
// ============================================================

/**
 * One register of a record row: the columns that change together, stamped by
 * the write that changed them last. The counter is the writer's count of its
 * writes to the group, so a device writing twice in one clock tick still
 * orders them; a group without one (a thread's delete) is written once.
 */
type Register = {
	clock: string;
	counter: string | undefined;
	device: string;
	columns: readonly string[];
};

const columnsOf = (table: RecordTable): string[] =>
	Object.keys(RECORD_ROW_SCHEMAS[table].shape).filter((c) => c !== "id");

/** Every column of `table` but the id, as one register. */
const wholeRow = (
	table: RecordTable,
	clock: string,
	device: string,
): Register[] => [
	{ clock, counter: "version", device, columns: columnsOf(table) },
];

const CLAIM_COLUMNS = [
	"state",
	"assignee",
	"state_updated_at",
	"state_updated_by",
	"state_updated_device",
	"state_version",
];
const DELETE_COLUMNS = ["deleted_at", "deleted_device"];

/**
 * A thread is three registers. The claim (state, assignee) and the text
 * (everything else) each keep their own clock, so a title edited offline
 * leaves another device's claim alone. The delete is the third: a live row's
 * `deleted_at` is null and loses to any delete, so once deleted a thread stays
 * deleted on every device, whatever its other registers take afterwards.
 */
const REGISTERS: Record<RecordTable, readonly Register[]> = {
	threads: [
		{
			clock: "updated_at",
			counter: "version",
			device: "updated_device",
			columns: columnsOf("threads").filter(
				(c) => !CLAIM_COLUMNS.includes(c) && !DELETE_COLUMNS.includes(c),
			),
		},
		{
			clock: "state_updated_at",
			counter: "state_version",
			device: "state_updated_device",
			columns: CLAIM_COLUMNS,
		},
		{
			clock: "deleted_at",
			counter: undefined,
			device: "deleted_device",
			columns: DELETE_COLUMNS,
		},
	],
	entries: wholeRow("entries", "created_at", "created_device"),
	attributes: wholeRow("attributes", "updated_at", "updated_device"),
	links: wholeRow("links", "updated_at", "updated_device"),
	refs: wholeRow("refs", "updated_at", "updated_device"),
};

/** Null lowest, then numbers, then strings: a total order over stored values. */
const compareValues = (a: unknown, b: unknown): number => {
	const rank = (v: unknown) =>
		v === null || v === undefined ? 0 : typeof v === "number" ? 1 : 2;
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
	if (typeof a === "number" && typeof b === "number") return a - b;
	const [x, y] = [String(a ?? ""), String(b ?? "")];
	return x === y ? 0 : x < y ? -1 : 1;
};

const contentOf = (row: Row, register: Register): string =>
	JSON.stringify(register.columns.map((c) => row[c] ?? null));

/** Positive when `a` holds the greater value of `register`. */
const compareRegister = (a: Row, b: Row, register: Register): number =>
	compareValues(a[register.clock], b[register.clock]) ||
	(register.counter === undefined
		? 0
		: compareValues(a[register.counter], b[register.counter])) ||
	compareValues(a[register.device], b[register.device]) ||
	compareValues(contentOf(a, register), contentOf(b, register));

type RecordDecision = Extract<ResolveDecision, { kind: "apply" | "skip" }>;

const decideRecordRow = (
	table: RecordTable,
	op: SyncOp,
	local: Row | undefined,
): RecordDecision => {
	// A record row is never hard-deleted: its delete is a tombstone, written
	// as an update. An op saying otherwise came from no writer of this record.
	if (op.op === "delete" || !op.rowId.isWellFormed())
		return skip("malformed-payload");
	const parsed = RECORD_ROW_SCHEMAS[table].safeParse(op.payload);
	if (!parsed.success) return skip("malformed-payload");
	const incoming: Row = parsed.data;
	if (isKeyedTable(table)) {
		if (
			incoming.id !== op.rowId ||
			RecordId.forRow(table, incoming) !== op.rowId
		)
			return skip("key-id-mismatch");
	} else if (incoming.id !== op.rowId) return skip("malformed-payload");
	const apply = (row: Row): RecordDecision => ({
		kind: "apply",
		rowId: op.rowId,
		row,
		dropRowId: undefined,
	});
	if (local === undefined) return apply(incoming);

	let merged = local;
	for (const register of REGISTERS[table]) {
		if (compareRegister(incoming, local, register) <= 0) continue;
		for (const column of register.columns)
			merged = { ...merged, [column]: incoming[column] ?? null };
	}
	return merged === local ? skip("not-newer") : apply(merged);
};

// ============================================================
// Resolve Namespace
// ============================================================

export namespace Resolve {
	/** How `tbl` resolves, or undefined when this device replicates no such table. */
	export const rule = ruleFor;

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
		const rule = ruleFor(op.tbl);
		if (rule === undefined) return skip("unknown-table");

		if (op.op === "delete") return resolveDelete(rule, op, local);

		const payload = op.payload;
		if (payload === undefined) return skip("malformed-payload");

		// First: the parent was deleted on another device, and an orphan insert
		// aborts the whole apply transaction rather than just itself.
		if (local.parentPresent === false && rule.childOfTasks) {
			return skip("orphan-parent");
		}

		// Tombstone-free, so a known delete is the only evidence that an absent
		// row was deleted rather than never seen.
		if (
			local.byId === undefined &&
			local.deletedAt !== undefined &&
			!(opClock(op, rule) > local.deletedAt)
		) {
			return skip("deleted");
		}

		return RESOLVERS[rule.family]({ rule, op, payload, local });
	};

	/**
	 * What one op does to a row of the 2.0 record: the merge of the row held
	 * here and the row the op carries, register by register, or a skip when the
	 * held row already wins every register. Order-free and idempotent: no
	 * delete evidence, no parent check, nothing about the receiving device.
	 */
	export const decideRecord = decideRecordRow;
}
