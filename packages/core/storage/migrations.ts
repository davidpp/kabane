/**
 * Storage — the schema's migration list.
 *
 * `Planner.init` runs `Migrations.apply` on every boot; the runner in
 * `db/migrate.ts` applies whatever this list holds above the database's
 * recorded version, once. To change the schema, append a migration here. Never
 * edit or reorder one that has shipped, and never edit `SCHEMA_SQL`: it is
 * migration 1, and a fresh database must end at the same schema as an upgraded
 * one.
 *
 * MIGRATION 1 IS THE RELEASE BASELINE. A database with no version table is
 * either fresh (no tasks table yet) or pre-release: created by a build older
 * than this runner, which re-ran the whole schema plus a list of column-guarded
 * steps on every boot. Both take the same path, because every pre-release step
 * checks the column before touching it and finds nothing to do on a fresh
 * database. The pre-release steps exist only for David's own devices and
 * Jake's shared `jake.db`; once each of those has booted on this build and been
 * stamped, `PreRelease` can be deleted and migration 1 becomes the schema, the
 * late indexes and nothing else.
 *
 * A TABLE A RELEASE RETIRES keeps its place in migration 1, which still creates
 * it, and a later migration drops it. `TABLES` stops listing it, so the steps
 * that still touch it name it with `physicalTable("<logical name>")`.
 */

import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import { applySchema } from "../db/schema";
import { physicalTable } from "../db/tables";
import type { Result } from "../result";
import { columnExists, TABLES } from "./helpers";
import { Oplog } from "./oplog";

/**
 * What a pre-release database may still lack, brought up to the baseline. Every
 * step is guarded, so on a fresh or already-current database it does nothing.
 */
namespace PreRelease {
	/** The snapshot columns a linked issue no longer carries (JCAB-61). None is indexed, which is what makes DROP COLUMN legal. */
	const DROPPED_UPSTREAM_SNAPSHOT_COLUMNS = [
		"description",
		"state",
		"external_updated_at",
		"refreshed_at",
	] as const;

	/** The physical names of the tables that replicate, for the column migration. */
	const replicatedTables = (): string[] => [
		TABLES.tasks,
		TABLES.projects,
		TABLES.task_links,
		physicalTable("focus_lists"), // retired by migration 3
		TABLES.comments,
		TABLES.work_log,
		TABLES.context_refs,
		TABLES.upstream_links,
	];

	const addColumnIfMissing = (
		db: Db,
		table: string,
		column: string,
		ddl: string,
	): void => {
		if (columnExists(db, table, column)) return;
		db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
	};

	const dropColumnIfPresent = (db: Db, table: string, column: string): void => {
		if (!columnExists(db, table, column)) return;
		db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
	};

	/**
	 * Linked issues used to be identity plus a snapshot of the external issue's
	 * content, and the content is what kept them private. The columns go, and the
	 * rows held back are released, but only on a database that still has the
	 * columns: a link made private later, on purpose, is not touched. (Before
	 * this runner the release ran on every boot and would have undone that.)
	 */
	const releaseSnapshotEraLinks = (db: Db): void => {
		const snapshotEra = DROPPED_UPSTREAM_SNAPSHOT_COLUMNS.some((column) =>
			columnExists(db, TABLES.upstream_links, column),
		);
		if (!snapshotEra) return;
		for (const column of DROPPED_UPSTREAM_SNAPSHOT_COLUMNS) {
			dropColumnIfPresent(db, TABLES.upstream_links, column);
		}
		db.run(
			`UPDATE ${TABLES.upstream_links} SET visibility = 'shared'
			 WHERE visibility = 'private'`,
		);
	};

	/** Throws on failure, which is how the runner's transaction rolls back. */
	export const upgrade = (db: Db): void => {
		// Columns added after their table first shipped. SQLite cannot ADD COLUMN
		// with UNIQUE, so short_id's uniqueness comes from the late index below.
		addColumnIfMissing(db, TABLES.tasks, "short_id", "TEXT");
		addColumnIfMissing(db, TABLES.tasks, "project_id", "TEXT");
		addColumnIfMissing(
			db,
			TABLES.tasks,
			"kind",
			"TEXT NOT NULL DEFAULT 'task'",
		);
		// Retired by migration 2.
		const proposals = physicalTable("proposals");
		if (!columnExists(db, proposals, "task_id")) {
			db.run(`ALTER TABLE ${proposals} ADD COLUMN task_id TEXT`);
			db.run(
				`CREATE INDEX IF NOT EXISTS ${proposals}_task_id_idx ON ${proposals}(task_id)`,
			);
		}

		// Replication columns on every synced table. Existing rows get version 1
		// and visibility 'shared', which is what they implicitly were.
		for (const table of replicatedTables()) {
			addColumnIfMissing(db, table, "updated_by", "TEXT");
			addColumnIfMissing(db, table, "version", "INTEGER NOT NULL DEFAULT 1");
			addColumnIfMissing(
				db,
				table,
				"visibility",
				"TEXT NOT NULL DEFAULT 'shared'",
			);
		}

		releaseSnapshotEraLinks(db);

		// Capture triggers from before explicit capture.
		const dropped = Oplog.dropLegacyTriggers(db);
		if (!dropped.ok) throw dropped.error;
	};
}

/**
 * The two indexes the DDL leaves out, because on a pre-release database their
 * columns only exist once `PreRelease.upgrade` has added them. Every database
 * gets them, fresh or upgraded.
 */
const createLateIndexes = (db: Db): void => {
	db.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS ${TABLES.tasks}_short_id_idx ON ${TABLES.tasks}(short_id)`,
	);
	db.run(
		`CREATE INDEX IF NOT EXISTS ${TABLES.tasks}_project_id_idx ON ${TABLES.tasks}(project_id)`,
	);
};

/** The time parts an end-of-UTC-day deadline was written with, by cabane and by Jake. */
const END_OF_UTC_DAY = [
	"T23:59:59.999Z",
	"T23:59:59.000Z",
	"T23:59:59Z",
	"T23:59:00.000Z",
	"T23:59:00Z",
] as const;

/** Drop a retired table; its indexes and triggers go with it. */
const dropTable = (db: Db, logical: string): void => {
	db.run(`DROP TABLE IF EXISTS ${physicalTable(logical)}`);
};

export namespace Migrations {
	/**
	 * Append-only. Version = index + 1. A migration may be any SQL over the
	 * physical names, including a backfill or a table rebuild.
	 */
	export const LIST: readonly Migrate.Migration[] = [
		{
			name: "baseline",
			up: (db) => {
				applySchema(db);
				PreRelease.upgrade(db);
				createLateIndexes(db);
			},
		},
		{
			// A retired surface: nothing in cabane reads or writes it, and Jake
			// retires its own proposals commands with it (JCAB-97).
			name: "drop-proposals",
			up: (db) => {
				// The FTS triggers are on `proposals` and go with it; the FTS table is its own.
				dropTable(db, "proposals");
				dropTable(db, "proposals_fts");
			},
		},
		{
			// Only Jake read or wrote focus lists, and it retires them (JCAB-97).
			// The table replicated: a focus-list op still arriving from a device on
			// an older build is skipped as `unknown-table`, and one still waiting in
			// this device's own log is pushed and skipped the same way elsewhere.
			name: "drop-focus-lists",
			up: (db) => dropTable(db, "focus_lists"),
		},
		{
			// Nothing read it. Sync apply wrote renames and lost-lineage records into
			// it; renames stay in `short_id_history`, and the rest was an audit trail
			// no surface showed.
			name: "drop-task-activity",
			up: (db) => dropTable(db, "task_activity"),
		},
		{
			// A deadline entered as a date used to be stored as the end of that day
			// in UTC, which falls due at 19:59 in Montreal and reads as the day
			// before in JavaScript. Those rows become the calendar date they meant;
			// every instant with a real time stays (schemas/deadline.ts, JCAB-101).
			// A device on an older build may still push an end-of-day instant
			// back; it reads on the same local day, so nothing lands wrong.
			name: "deadlines-as-dates",
			up: (db) => {
				db.run(
					`UPDATE ${TABLES.tasks} SET deadline = substr(deadline, 1, 10)
					 WHERE length(deadline) > 10
					   AND substr(deadline, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
					   AND substr(deadline, 11) IN (${END_OF_UTC_DAY.map((tail) => `'${tail}'`).join(", ")})`,
				);
			},
		},
	];

	/**
	 * The schema version this build writes. It rides on every pushed op, and a
	 * device on an older schema stops pulling at the first op above its own.
	 */
	export const SCHEMA_VERSION = LIST.length;

	/** Bring `db` up to `SCHEMA_VERSION`, or say which migration failed. */
	export const apply = (db: Db): Result<Migrate.Report> =>
		Migrate.run(db, LIST);
}
