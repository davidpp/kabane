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
import { type KabaneModule, Modules } from "../module";
import { err, ok, type Result } from "../result";
import { parseQuestionBody } from "../schemas";
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

/**
 * The tool permission requests a loop relayed as questions before JCAB-26, whose
 * answers were written as decisions. A question counts only when that is
 * certain: its body carries the `permission` block, and its text is exactly
 * what the loop's relay wrote, `<harness> asks to run: <the block's title>`.
 */
namespace RelayedPermissions {
	const ASKS = " asks to run: ";

	const isRelayed = (body: string): boolean => {
		const parsed = parseQuestionBody(body);
		if (!parsed.permission) return false;
		const harness = parsed.question.split(ASKS, 1)[0] ?? "";
		return (
			/^\S+$/.test(harness) &&
			parsed.question === `${harness}${ASKS}${parsed.permission.title}`.trim()
		);
	};

	/**
	 * Delete the decisions answering a relayed permission request, and the
	 * request itself once it is answered or its session has ended: left behind,
	 * it would read as a question still waiting on a human. One waiting on a
	 * live session stays, since a runner may still be polling for its answer.
	 * Sessions do not replicate, so nothing here enters the oplog.
	 */
	export const drop = (db: Db): void => {
		const questions = db
			.query<
				{ id: string; session_id: string; body: string; state: string },
				[]
			>(
				`SELECT q.id, q.session_id, q.body, s.state
				   FROM ${TABLES.agent_activities} q
				   JOIN ${TABLES.agent_sessions} s ON s.id = q.session_id
				  WHERE q.type = 'question' AND q.body LIKE '%"permission":%'`,
			)
			.all()
			.filter((q) => isRelayed(q.body));
		for (const q of questions) {
			const answers = db.run(
				`DELETE FROM ${TABLES.agent_activities}
				  WHERE session_id = ? AND type = 'decision' AND context = ?`,
				[q.session_id, `answers ${q.id}`],
			);
			if (answers.changes > 0 || q.state === "complete" || q.state === "error")
				db.run(`DELETE FROM ${TABLES.agent_activities} WHERE id = ?`, [q.id]);
		}
	};
}

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
		{
			// Approving a tool call is no decision (JCAB-26): `answerQuestion` now
			// answers a relayed permission request with an `answer`. The ones it
			// answered with a decision before go, with their requests, so a task's
			// decisions are the choices a human made.
			name: "drop-permission-decisions",
			up: RelayedPermissions.drop,
		},
		{
			// A decision answering a question names who chose (JCAB-26). Activities
			// written before have no author on record and read as the session's.
			// Guarded: a pre-release database re-runs the whole list from 1.
			name: "activity-author",
			up: (db) => {
				if (!columnExists(db, TABLES.agent_activities, "author"))
					db.run(
						`ALTER TABLE ${TABLES.agent_activities} ADD COLUMN author TEXT`,
					);
			},
		},
		{
			// Not shipped yet when it gained the oplog columns below, so it was
			// extended rather than followed by a ninth migration.
			// Ops for a data module this device has not registered, or for a newer
			// version of one it has (`module.ts`), wait here untouched instead of
			// being skipped, and apply once the module registers or migrates.
			// Machine-local: never captured, never replicated. `op` is the op as
			// pulled, JSON; `server_seq` is its place in the log, the replay order.
			// A replay that failed records why and when; it is tried again on every
			// pass, with its row's later ops behind it.
			name: "sync-parked",
			up: (db) => {
				db.run(
					`CREATE TABLE IF NOT EXISTS ${TABLES.sync_parked} (
					   op_id TEXT PRIMARY KEY,
					   server_seq INTEGER NOT NULL,
					   module TEXT NOT NULL,
					   module_schema INTEGER NOT NULL,
					   tbl TEXT NOT NULL,
					   row_id TEXT NOT NULL,
					   op TEXT NOT NULL,
					   parked_at TEXT NOT NULL,
					   error TEXT,
					   failed_at TEXT
					 )`,
				);
				db.run(
					`CREATE INDEX IF NOT EXISTS ${TABLES.sync_parked}_module_idx
					   ON ${TABLES.sync_parked}(module, server_seq)`,
				);
				// The delete a replay applied for a row whose later ops are still
				// parked. Sync keeps no tombstones and a pull's delete evidence lasts
				// one page, but a row's replay can span passes: without this, an
				// older update replayed after its module upgrades would bring back a
				// row an earlier pass deleted. Cleared once nothing for the row is
				// parked.
				db.run(
					`CREATE TABLE IF NOT EXISTS ${TABLES.sync_parked_deletes} (
					   tbl TEXT NOT NULL,
					   row_id TEXT NOT NULL,
					   deleted_at TEXT NOT NULL,
					   PRIMARY KEY (tbl, row_id)
					 )`,
				);
				// An op whose row already has one parked parks behind it.
				db.run(
					`CREATE INDEX IF NOT EXISTS ${TABLES.sync_parked}_row_idx
					   ON ${TABLES.sync_parked}(tbl, row_id, server_seq)`,
				);
				// A module table's op is tagged when it is captured, not when it is
				// pushed: the module may not be registered by then, and an untagged
				// op is dropped as `unknown-table` by every device without it.
				// Guarded: a pre-release database re-runs the whole list from 1.
				for (const [column, type] of [
					["module", "TEXT"],
					["module_schema", "INTEGER"],
				] as const) {
					if (!columnExists(db, TABLES.sync_oplog, column))
						db.run(
							`ALTER TABLE ${TABLES.sync_oplog} ADD COLUMN ${column} ${type}`,
						);
				}
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

	/**
	 * Bring each registered module up to its own list, in registration order,
	 * after core. Each records its versions in its own table, so a module
	 * migrating never moves `SCHEMA_VERSION`, and a database a newer build of a
	 * module migrated is refused for that module the way core refuses its own.
	 */
	export const applyModules = (
		db: Db,
		modules: readonly KabaneModule[],
	): Result<void> => {
		for (const module of modules) {
			// Run for an empty list too: a database a build of this module with
			// migrations has opened must still be refused by one without.
			const ran = Migrate.run(
				db,
				module.migrations ?? [],
				Modules.versionTable(module.name),
			);
			if (!ran.ok)
				return err(new Error(`module "${module.name}": ${ran.error.message}`));
		}
		return ok(undefined);
	};
}
