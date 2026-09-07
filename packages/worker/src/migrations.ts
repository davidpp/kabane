/**
 * Schema versioning.
 *
 * `PRAGMA user_version` is not supported in DO SQLite, so the version lives in a
 * `_sql_schema_migrations` table. Each entry in `MIGRATIONS` is one version, and
 * its index + 1 is that version number — append only, never reorder or edit a
 * shipped entry.
 *
 * Every statement is also `IF NOT EXISTS`, so the version table and the DDL
 * agree even on a database that predates the version table.
 */

const VERSION_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)
`;

/**
 * v1 — the whole server.
 *
 * `payload` is opaque JSON and is never parsed here. `op_id` carries the UNIQUE
 * constraint that makes a replayed push a no-op, and `server_seq` AUTOINCREMENT
 * is the total order every device applies in. `last_ack_seq` is advisory: the
 * device owns its own watermark, this is just how far the server last saw it get.
 */
const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE IF NOT EXISTS oplog (
		server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
		device_id TEXT NOT NULL,
		op_id TEXT NOT NULL UNIQUE,
		payload TEXT NOT NULL,
		received_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS devices (
		device_id TEXT PRIMARY KEY,
		name TEXT,
		last_ack_seq INTEGER NOT NULL DEFAULT 0
	);
	`,
];

/** Highest version in `MIGRATIONS`. What a fully migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export namespace Migrations {
	/**
	 * Bring the database up to `SCHEMA_VERSION`. Idempotent: a second call is a
	 * read of the version table and nothing else.
	 *
	 * Call from `blockConcurrencyWhile` in the constructor only. There are no
	 * `await`s in here, so write coalescing makes the DDL and the version row one
	 * atomic commit without `BEGIN TRANSACTION` (which is blocked anyway).
	 */
	export const apply = (sql: SqlStorage): number => {
		sql.exec(VERSION_TABLE_SQL);

		const current = sql
			.exec<{ version: number }>(
				"SELECT COALESCE(MAX(version), 0) AS version FROM _sql_schema_migrations",
			)
			.one().version;

		for (const [index, ddl] of MIGRATIONS.entries()) {
			const version = index + 1;
			if (version <= current) continue;

			sql.exec(ddl);
			sql.exec(
				"INSERT INTO _sql_schema_migrations (version, applied_at) VALUES (?, ?)",
				version,
				new Date().toISOString(),
			);
		}

		return Math.max(current, SCHEMA_VERSION);
	};
}
