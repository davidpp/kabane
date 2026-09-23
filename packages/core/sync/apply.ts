/**
 * Planner Sync — Apply
 *
 * Write a pulled batch into the local DB: ordered by `serverSeq`, in one
 * transaction, one `Resolve` decision per op. Rows are written directly, not
 * through the storage functions, so nothing here is ever captured: a pulled
 * row cannot ping-pong back into the log, and no guard is needed.
 *
 * VERSION IS THE HIGH-WATER MARK, NOT THE INCOMING VALUE. An applied row takes
 * `max(local.version, incoming.version)` so a later local edit always moves
 * past both lineages.
 *
 * RESOLVE BEFORE EXECUTE, PER OP, ALWAYS. Every decision is computed before its
 * statement is issued, and a `skip` means no statement at all. This is not a
 * style preference: `foreign_keys = ON` and one transaction mean an insert whose
 * FK parent was deleted on another device fails with `FOREIGN KEY constraint
 * failed` and SQLite has already rolled the whole batch back — a legitimate
 * sibling `UPDATE` included — before any `try/catch` could intervene. There is
 * no recovery after the fact, only prevention before it.
 *
 * BUT NOT ALL AT ONCE. The lookups feeding one decision are read immediately
 * before that op's write, not once for the whole batch. Resolving the batch
 * against a single pre-pass snapshot would see the parent of a same-batch child
 * as absent and skip every legitimately new child row — a task created with two
 * comments on another device would arrive as a task and nothing else. Walking in
 * `seq` order with fresh reads is what makes the parent-then-child ordering the
 * log already guarantees actually usable.
 *
 * APPLY OWNS FK SAFETY, NOT JUST THE ORPHAN RULE. `Resolve` guards the four
 * tables holding an FK to `tasks`, but `tasks` itself has two FK parents
 * (`parent_task_id`, `project_id`) and a dangling one aborts the transaction
 * exactly the same way. So the presence check runs here, for every table, before
 * the resolver is consulted — and mirrors the FK's own declared action: a missing
 * `ON DELETE CASCADE` parent skips the row (the receiving device's own cascade
 * would have removed it), a missing `ON DELETE SET NULL` parent clears the column
 * (its cascade did exactly that). Both choices converge; the opposite of either
 * leaves the two devices permanently different.
 *
 * WHOLE ROWS, NEVER PROJECTIONS. Local lookups `SELECT *` because the resolver
 * reads a per-table clock column out of the row it is handed — `updated_at` for
 * most tables, `added_at` for `task_context_refs`, none at all for
 * `task_work_log` and `task_links`. Selecting a subset would silently feed it a
 * missing clock and turn LWW into first-writer-wins.
 *
 * SKIPS ARE COUNTED, NEVER SWALLOWED. `Resolve` is total by design so one
 * malformed op cannot wedge `last_applied_seq` forever, which only works if the
 * caller can see what it dropped. Every reason in `SKIP_REASONS` is reported,
 * zero-filled, on every pass.
 */

import type { Db } from "../db/port";
import type { Result } from "../result";
import { atomic } from "../runtime";

import { SYNC_TABLES, type SyncTable } from "../schemas";
import { TABLES } from "../storage/helpers";
import { Oplog, physicalTableFor } from "../storage/oplog";
import {
	Resolve,
	type ResolveDecision,
	SKIP_REASONS,
	type SkipReason,
} from "./resolve";
import type { PullPage, RelayOp } from "./transport";

// ============================================================
// Constants
// ============================================================

/**
 * The UNIQUE key a table carries beside its primary key. Two devices can mint
 * two ULIDs for one logical row, and these columns are how the resolver
 * recognizes that.
 */
const NATURAL_KEY: Partial<Record<SyncTable, readonly string[]>> = {
	task_links: ["source_id", "target_id", "type"],
	task_context_refs: ["task_id", "uri"],
	upstream_links: ["task_id", "provider", "external_id"],
};

/** Tables carrying a human-facing `short_id`, i.e. the ones a rename can hit. */
const SHORT_ID_TABLES: readonly SyncTable[] = ["tasks", "projects"];

/**
 * What SQLite does to this row when the parent goes away. Apply reproduces it
 * for a parent that was deleted on another device, because the local FK already
 * did the same thing when that parent's delete op was applied.
 */
type ParentRef = {
	column: string;
	table: string;
	onDelete: "cascade" | "set-null";
};

const PARENTS: Record<SyncTable, readonly ParentRef[]> = {
	tasks: [
		{ column: "parent_task_id", table: TABLES.tasks, onDelete: "cascade" },
		{ column: "project_id", table: TABLES.projects, onDelete: "set-null" },
	],
	projects: [],
	task_links: [
		{ column: "source_id", table: TABLES.tasks, onDelete: "cascade" },
		{ column: "target_id", table: TABLES.tasks, onDelete: "cascade" },
	],
	task_comments: [
		{ column: "task_id", table: TABLES.tasks, onDelete: "cascade" },
	],
	task_work_log: [
		{ column: "task_id", table: TABLES.tasks, onDelete: "cascade" },
	],
	task_context_refs: [
		{ column: "task_id", table: TABLES.tasks, onDelete: "cascade" },
	],
	upstream_links: [
		{ column: "task_id", table: TABLES.tasks, onDelete: "cascade" },
	],
};

// ============================================================
// Types
// ============================================================

type Row = Record<string, unknown>;

/** Everything SQLite will accept from a JSON row snapshot. */
type BindValue = string | number | null;

/** Per-table facts read once per pass. */
type TableMeta = {
	table: SyncTable;
	physical: string;
	/** Live column list, so a column a newer device sent is dropped, not fatal. */
	columns: string[];
	naturalKey: readonly string[] | undefined;
	hasShortId: boolean;
};

/** What one pass did. Every number is here so nothing is silent. */
export type ApplyReport = {
	/** Ops in the batch, before any filtering. */
	received: number;
	/** Decisions executed (writes, merges, renames, deletes). */
	applied: number;
	/** `short_id` reassignments, each recorded in `short_id_history`. */
	renamed: number;
	/** FK columns nulled because their parent was deleted on another device. */
	clearedRefs: number;
	/** Ops not applied, by reason. Zero-filled from `SKIP_REASONS`. */
	skipped: Record<SkipReason, number>;
	/** The `last_applied_seq` this pass advanced to. */
	throughSeq: number;
};

// ============================================================
// Private Helpers — reads
// ============================================================

const isSyncTable = (tbl: string): tbl is SyncTable =>
	(SYNC_TABLES as readonly string[]).includes(tbl);

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

const tableMeta = (db: Db, table: SyncTable): TableMeta => ({
	table,
	physical: physicalTableFor(table),
	columns: db
		.query<{ name: string }, []>(
			`PRAGMA table_info(${physicalTableFor(table)})`,
		)
		.all()
		.map((column) => column.name),
	naturalKey: NATURAL_KEY[table],
	hasShortId: SHORT_ID_TABLES.includes(table),
});

/**
 * JSON row snapshots only ever hold scalars, because `json_object` reads column
 * values. Anything else is stringified rather than dropped, so a future column
 * holding structured JSON round-trips instead of vanishing.
 */
const toBind = (value: unknown): BindValue => {
	if (value === null || value === undefined) return null;
	if (typeof value === "string" || typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	return JSON.stringify(value);
};

/** Whole row or nothing — the resolver needs the clock column, whichever it is. */
const selectRow = (
	db: Db,
	physical: string,
	where: string,
	params: BindValue[],
): Row | undefined =>
	db
		.query<Row, BindValue[]>(`SELECT * FROM ${physical} WHERE ${where} LIMIT 1`)
		.get(...params) ?? undefined;

const rowExists = (db: Db, physical: string, id: string): boolean =>
	(db
		.query<{ one: number }, [string]>(
			`SELECT 1 AS one FROM ${physical} WHERE id = ? LIMIT 1`,
		)
		.get(id) ?? undefined) !== undefined;

const byNaturalKey = (
	db: Db,
	meta: TableMeta,
	payload: Row | undefined,
): Row | undefined => {
	if (meta.naturalKey === undefined || payload === undefined) return undefined;

	const where = meta.naturalKey
		.map((column) => `"${column}" = ?`)
		.join(" AND ");
	const params = meta.naturalKey.map((column) => toBind(payload[column]));
	return selectRow(db, meta.physical, where, params);
};

const byShortId = (
	db: Db,
	meta: TableMeta,
	payload: Row | undefined,
): Row | undefined => {
	const shortId =
		payload === undefined ? undefined : asString(payload.short_id);
	if (!meta.hasShortId || shortId === undefined) return undefined;
	return selectRow(db, meta.physical, `short_id = ?`, [shortId]);
};

// ============================================================
// Private Helpers — writes
// ============================================================

/**
 * Upsert on the primary key.
 *
 * `INSERT OR REPLACE` is not usable here: it DELETEs the conflicting row first,
 * which with `foreign_keys = ON` cascades away a task's comments, work logs,
 * links and context refs on every ordinary update. `ON CONFLICT DO UPDATE`
 * touches nothing but the row.
 *
 * Columns the local table does not have are dropped — a newer device may send a
 * column this build never heard of, and `no such column` would abort the batch.
 */
const writeRow = (db: Db, meta: TableMeta, rowId: string, row: Row) => {
	const full: Row = { ...row, id: rowId };
	const columns = meta.columns.filter((column) => column in full);
	const quoted = columns.map((column) => `"${column}"`);
	const placeholders = columns.map(() => "?").join(", ");
	const params = columns.map((column) => toBind(full[column]));

	const updates = columns
		.filter((column) => column !== "id")
		.map((column) => `"${column}" = excluded."${column}"`);
	const onConflict =
		updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;

	db.run(
		`INSERT INTO ${meta.physical} (${quoted.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT(id) ${onConflict}`,
		params,
	);
};

const deleteRow = (db: Db, physical: string, rowId: string) => {
	db.run(`DELETE FROM ${physical} WHERE id = ?`, [rowId]);
};

const versionOf = (row: Row | undefined): number | undefined =>
	typeof row?.version === "number" ? row.version : undefined;

/** The row to write: incoming content, version raised to the high-water mark. */
const withVersion = (row: Row, local: Row | undefined): Row => ({
	...row,
	version: Math.max(versionOf(local) ?? 0, versionOf(row) ?? 1),
});

// ============================================================
// Private Helpers — short_id renames
// ============================================================

/** `JJAK` out of `JJAK-42`. A contested label is always well-formed. */
const labelPrefix = (shortId: string): string =>
	shortId.slice(0, shortId.lastIndexOf("-"));

const labelSuffix = (shortId: string, prefix: string): number => {
	const parsed = Number.parseInt(shortId.slice(prefix.length + 1), 10);
	return Number.isFinite(parsed) ? parsed : 0;
};

/** Highest number already issued for `prefix` in this table. */
const localMaxSuffix = (db: Db, physical: string, prefix: string): number =>
	db
		.query<{ max_n: number | null }, [number, string]>(
			`SELECT MAX(CAST(substr(short_id, ?) AS INTEGER)) AS max_n
         FROM ${physical} WHERE short_id LIKE ?`,
		)
		.get(prefix.length + 2, `${prefix}-%`)?.max_n ?? 0;

/**
 * Stop a prefix counter from ever re-issuing a number at or below `through`.
 *
 * `next_number` holds the LAST issued number despite its name, so setting it to
 * `through` makes the next `generateShortId` hand out `through + 1`.
 */
const reserveThrough = (
	db: Db,
	prefix: string,
	through: number,
	now: string,
) => {
	db.run(
		`INSERT INTO ${TABLES.sequences} (prefix, next_number, scope_uri, created_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(prefix) DO UPDATE
        SET next_number = MAX(next_number, excluded.next_number)`,
		[prefix, through, now],
	);
};

/**
 * A free label for the loser of a `short_id` collision.
 *
 * Derived from the highest number OBSERVED — locally and anywhere in this batch
 * — rather than from the local counter, for two reasons. A counter can hand out
 * a label that a row arriving later in the same batch already holds, and a
 * UNIQUE violation aborts the whole apply. And a counter is machine-local, so
 * two devices renaming the same loser would mint two different labels; since the
 * rename runs under the guard and is never captured, that difference would never
 * reconcile. The observed maximum is the same on both sides whenever they have
 * seen the same log, which makes the rename converge.
 *
 * The counter is then raised past the minted label so a later local `plan add`
 * cannot collide with it.
 */
const mintShortId = (
	db: Db,
	meta: TableMeta,
	contested: string,
	batchLabels: readonly string[],
	now: string,
): string => {
	const prefix = labelPrefix(contested);
	const batchMax = batchLabels
		.filter((label) => label.startsWith(`${prefix}-`))
		.reduce((max, label) => Math.max(max, labelSuffix(label, prefix)), 0);
	const next =
		Math.max(localMaxSuffix(db, meta.physical, prefix), batchMax) + 1;

	reserveThrough(db, prefix, next, now);
	return `${prefix}-${next}`;
};

/**
 * Leave the loss discoverable.
 *
 * `short_id_history` is the durable audit trail — NOT a lookup fallback. The
 * winner keeps the contested label live, so resolving it finds the winner's real
 * row and never reaches history; a fallback could only ever return the wrong
 * task. See the `short_id` ruling in `packages/planner/CLAUDE.md`.
 */
const recordSupersession = (
	db: Db,
	args: {
		loserId: string;
		oldShortId: string;
		now: string;
	},
) => {
	const { loserId, oldShortId, now } = args;

	// One label can be claimed by more than two devices, and the audit table
	// keys on the label alone. Freshest supersession wins rather than failing
	// the batch.
	db.run(
		`INSERT INTO ${TABLES.short_id_history} (old_short_id, task_id, superseded_at)
     VALUES (?, ?, ?)
     ON CONFLICT(old_short_id) DO UPDATE
        SET task_id = excluded.task_id, superseded_at = excluded.superseded_at`,
		[oldShortId, loserId, now],
	);
};

/**
 * Execute a rename. The ULID-earlier row keeps the label; the loser is
 * relabelled, and the two writes happen in one statement group because UNIQUE
 * rejects the second claimant otherwise.
 */
const executeRename = (
	db: Db,
	meta: TableMeta,
	decision: Extract<ResolveDecision, { kind: "rename" }>,
	batchLabels: readonly string[],
	now: string,
) => {
	const { rowId, row, loserId, shortId } = decision;

	if (loserId === rowId) {
		// The INCOMING row is the loser: write it under the new label, never the
		// contested one it arrived with.
		const minted = mintShortId(db, meta, shortId, batchLabels, now);
		writeRow(db, meta, rowId, { ...row, short_id: minted });
		recordSupersession(db, { loserId, oldShortId: shortId, now });
		return;
	}

	// The LOCAL row is the loser: free the label before the winner claims it.
	// `updated_at` is deliberately left alone — the rename is not captured, so
	// bumping the clock here would only desynchronize LWW comparisons later.
	const minted = mintShortId(db, meta, shortId, batchLabels, now);
	db.run(`UPDATE ${meta.physical} SET short_id = ? WHERE id = ?`, [
		minted,
		loserId,
	]);
	writeRow(db, meta, rowId, row);
	recordSupersession(db, { loserId, oldShortId: shortId, now });
};

// ============================================================
// Private Helpers — the pass
// ============================================================

const zeroSkips = (): Record<SkipReason, number> =>
	Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
		SkipReason,
		number
	>;

/** Every `short_id` anywhere in the batch, whatever its table or fate. */
const collectLabels = (ops: readonly RelayOp[]): string[] => {
	const labels: string[] = [];
	for (const op of ops) {
		const label =
			op.payload === undefined ? undefined : asString(op.payload.short_id);
		if (label?.includes("-")) labels.push(label);
	}
	return labels;
};

/** Tombstone-free storage: an absent row is otherwise a never-seen row. */
const deleteKey = (tbl: string, rowId: string): string => `${tbl} ${rowId}`;

type Prepared = {
	op: RelayOp;
	/** Every FK parent present, after `set-null` columns were cleared. */
	parentPresent: boolean;
	cleared: number;
};

const prepareParents = (db: Db, table: SyncTable, op: RelayOp): Prepared => {
	if (op.payload === undefined) {
		return { op, parentPresent: true, cleared: 0 };
	}

	let payload = op.payload;
	let parentPresent = true;
	let cleared = 0;

	for (const parent of PARENTS[table]) {
		const value = asString(payload[parent.column]);
		if (value === undefined) continue;
		if (rowExists(db, parent.table, value)) continue;

		if (parent.onDelete === "set-null") {
			payload = { ...payload, [parent.column]: null };
			cleared++;
			continue;
		}
		parentPresent = false;
	}

	return {
		op: payload === op.payload ? op : { ...op, payload },
		parentPresent,
		cleared,
	};
};

/**
 * Raise every counter the batch touched past the labels it delivered, so the
 * next local create in a scope this device just learned about cannot mint a
 * label an applied row already holds. `sequences` is machine-local and never
 * replicates, so nothing else does this.
 */
const reserveBatchLabels = (db: Db, labels: readonly string[], now: string) => {
	const highest = new Map<string, number>();
	for (const label of labels) {
		const prefix = labelPrefix(label);
		const suffix = labelSuffix(label, prefix);
		highest.set(prefix, Math.max(highest.get(prefix) ?? 0, suffix));
	}
	for (const [prefix, suffix] of highest) {
		reserveThrough(db, prefix, suffix, now);
	}
};

const applyOrdered = (
	db: Db,
	page: PullPage,
	localDeviceId: string,
): ApplyReport => {
	const ordered = [...page.ops].sort((a, b) => a.serverSeq - b.serverSeq);
	const batchLabels = collectLabels(ordered);
	const now = new Date().toISOString();

	const skipped = zeroSkips();
	const deletedAt = new Map<string, string>();
	const metas = new Map<SyncTable, TableMeta>();
	let applied = 0;
	let renamed = 0;
	let clearedRefs = 0;

	for (const op of ordered) {
		if (!isSyncTable(op.tbl)) {
			skipped["unknown-table"]++;
			continue;
		}
		const table = op.tbl;

		const meta = metas.get(table) ?? tableMeta(db, table);
		metas.set(table, meta);

		const prepared = prepareParents(db, table, op);
		clearedRefs += prepared.cleared;

		// Before the resolver, and for every table: a dangling FK is the one
		// failure that takes the whole batch down with it. Deletes carry no
		// payload and no FK, so only writes can land here.
		if (!prepared.parentPresent) {
			skipped["orphan-parent"]++;
			continue;
		}

		const payload = prepared.op.payload;
		const localById = selectRow(db, meta.physical, "id = ?", [op.rowId]);
		const localByKey = byNaturalKey(db, meta, payload);
		const decision = Resolve.decide(prepared.op, {
			byId: localById,
			byNaturalKey: localByKey,
			byShortId: byShortId(db, meta, payload),
			parentPresent: prepared.parentPresent,
			deletedAt: deletedAt.get(deleteKey(op.tbl, op.rowId)),
			localDeviceId,
		});

		// Every delete seen counts as evidence the row was deleted, applied or
		// not: a later insert of it from a third device must still lose.
		if (op.op === "delete") {
			deletedAt.set(deleteKey(op.tbl, op.rowId), op.capturedAt);
		}

		switch (decision.kind) {
			case "skip":
				skipped[decision.reason]++;
				break;
			case "delete":
				deleteRow(db, meta.physical, decision.rowId);
				applied++;
				break;
			case "apply": {
				if (decision.dropRowId !== undefined) {
					deleteRow(db, meta.physical, decision.dropRowId);
				}
				const local = localById ?? localByKey;
				const row = withVersion(decision.row, local);
				writeRow(db, meta, decision.rowId, row);
				applied++;
				break;
			}
			case "rename":
				executeRename(db, meta, decision, batchLabels, now);
				applied++;
				renamed++;
				break;
		}
	}

	reserveBatchLabels(db, batchLabels, now);

	db.run(
		`UPDATE ${TABLES.sync_state}
        SET last_applied_seq = MAX(last_applied_seq, ?), updated_at = ?
      WHERE id = 'local'`,
		[page.throughSeq, now],
	);

	return {
		received: page.ops.length,
		applied,
		renamed,
		clearedRefs,
		skipped,
		throughSeq: page.throughSeq,
	};
};

const applyBatchImpl = async (
	basePath: string,
	page: PullPage,
): Promise<Result<ApplyReport>> =>
	// Throwing is how `atomic` is told to ROLLBACK; it converts the throw into
	// an `err`, so nothing escapes as an exception.
	atomic(basePath, (db) => {
		const state = Oplog.getState(db);
		if (!state.ok) throw state.error;
		if (state.value === undefined) {
			throw new Error(
				"Cannot apply sync ops: this device has no sync state. Call Oplog.initDevice first.",
			);
		}
		return applyOrdered(db, page, state.value.deviceId);
	});

// ============================================================
// Apply Namespace
// ============================================================

export namespace Apply {
	/**
	 * Write one pulled page into the local DB, atomically.
	 *
	 * Ordered by `serverSeq`, one transaction, never captured (rows are written
	 * directly, below the capture step), and `last_applied_seq` advanced inside
	 * the same transaction so a crash can never leave the watermark ahead of the
	 * rows.
	 *
	 * Idempotent: re-applying the same page resolves to `already-present` /
	 * `not-newer` / `already-absent` skips and writes nothing new.
	 */
	export const applyBatch = applyBatchImpl;

	/** An empty report, for callers aggregating across pages. */
	export const emptyReport = (throughSeq: number): ApplyReport => ({
		received: 0,
		applied: 0,
		renamed: 0,
		clearedRefs: 0,
		skipped: zeroSkips(),
		throughSeq,
	});

	/** Fold one page's report into a running total. */
	export const mergeReports = (
		into: ApplyReport,
		next: ApplyReport,
	): ApplyReport => ({
		received: into.received + next.received,
		applied: into.applied + next.applied,
		renamed: into.renamed + next.renamed,
		clearedRefs: into.clearedRefs + next.clearedRefs,
		skipped: Object.fromEntries(
			SKIP_REASONS.map((reason) => [
				reason,
				into.skipped[reason] + next.skipped[reason],
			]),
		) as Record<SkipReason, number>,
		throughSeq: Math.max(into.throughSeq, next.throughSeq),
	});
}
