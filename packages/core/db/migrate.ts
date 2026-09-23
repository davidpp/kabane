/**
 * The migration runner: a numbered, append-only list applied once per database.
 *
 * Every database carries a version table (`schema_migrations`, through the
 * table prefix, so Jake's shared `jake.db` gets `planner_schema_migrations`).
 * A migration's version is its index in the list plus one. The runner applies
 * every migration above the recorded version, each inside one transaction
 * together with the row that records it, so a migration that throws leaves the
 * database exactly as the previous one left it and says which one failed.
 *
 * WHY RAW SQL AND NOT A LIBRARY. The core runs on two SQLite engines behind one
 * port (`bun:sqlite` on devices, Durable Object SQLite for the hub's cloud
 * device), and DO SQLite refuses `BEGIN` and `PRAGMA user_version`. A table and
 * the port's own `transaction` are the whole mechanism; an ORM's migrator would
 * need an adapter per engine for less than this file does. The hub's sync-log
 * object (packages/worker/src/migrations.ts) uses the same pattern for its own,
 * separate schema.
 *
 * TWO PROCESSES OPENING ONE FILE AT ONCE (the board and `cabane mcp`, say) are
 * safe: each migration's first statement claims its version row with
 * `INSERT OR IGNORE`, which takes the write lock before anything else is read.
 * The loser waits on the lock, finds the row already there, and skips the
 * migration instead of running it twice or failing on the key.
 *
 * Migrations are synchronous on purpose. A DO commits a synchronous block
 * atomically, and an `await` inside a bun transaction would commit it early.
 */

import { err, ok, type Result, trySync } from "../result";
import type { Db } from "./port";
import { TABLES } from "./tables";

export namespace Migrate {
	/**
	 * One schema step. `up` runs once per database. Any SQL goes, including a
	 * backfill or a table rebuild, as long as it is written against the physical
	 * names (`TABLES.x`) so the prefix holds.
	 */
	export type Migration = {
		/** A short slug, recorded beside the version for whoever reads the table. */
		name: string;
		up: (db: Db) => void;
	};

	export type Report = {
		/** The version the database was at before this run. */
		from: number;
		/** The version it is at now. */
		to: number;
		/** Names of the migrations this run applied, in order. */
		applied: string[];
	};

	const ensureVersionTable = (db: Db, table: string): void => {
		db.exec(
			`CREATE TABLE IF NOT EXISTS ${table} (
			   version INTEGER PRIMARY KEY,
			   name TEXT NOT NULL,
			   applied_at TEXT NOT NULL
			 )`,
		);
	};

	const tableExists = (db: Db, table: string): boolean =>
		db
			.query<{ one: number }, [string]>(
				"SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(table) !== null;

	/**
	 * The version a database is at: the highest recorded migration, or 0 for a
	 * database that has no version table yet (fresh, or older than this runner).
	 */
	export const current = (
		db: Db,
		table: string = TABLES.schema_migrations,
	): number => {
		if (!tableExists(db, table)) return 0;
		return (
			db
				.query<{ version: number | null }, []>(
					`SELECT MAX(version) AS version FROM ${table}`,
				)
				.get()?.version ?? 0
		);
	};

	/** Claim `version` and run `up` in one transaction. False when already claimed. */
	const applyOne = (
		db: Db,
		table: string,
		version: number,
		migration: Migration,
	): boolean =>
		db.transaction(() => {
			const claimed = db.run(
				`INSERT OR IGNORE INTO ${table} (version, name, applied_at) VALUES (?, ?, ?)`,
				[version, migration.name, new Date().toISOString()],
			);
			if (claimed.changes === 0) return false;
			migration.up(db);
			return true;
		})();

	/**
	 * Bring `db` up to `migrations.length`. A second call is a read of the
	 * version table and nothing else.
	 *
	 * Refuses a database already past the list: a newer cabane migrated it, and
	 * this build writing to a schema it does not know is how rows get damaged.
	 */
	export const run = (
		db: Db,
		migrations: readonly Migration[],
		table: string = TABLES.schema_migrations,
	): Result<Report> => {
		const prepared = trySync(() => {
			ensureVersionTable(db, table);
			return current(db, table);
		});
		if (!prepared.ok) return prepared;
		const from = prepared.value;

		if (from > migrations.length) {
			return err(
				new Error(
					`this database is at schema version ${from}, newer than this cabane knows (${migrations.length}); update cabane before opening it`,
				),
			);
		}

		const applied: string[] = [];
		for (const [index, migration] of migrations.entries()) {
			const version = index + 1;
			if (version <= from) continue;
			const outcome = trySync(() => applyOne(db, table, version, migration));
			if (!outcome.ok) {
				return err(
					new Error(
						`schema migration ${version} (${migration.name}) failed and was rolled back; the database is still at version ${version - 1}: ${outcome.error.message}`,
					),
				);
			}
			if (outcome.value) applied.push(migration.name);
		}

		return ok({ from, to: Math.max(from, migrations.length), applied });
	};
}
