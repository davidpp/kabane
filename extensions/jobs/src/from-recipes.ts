import type { Db, KabaneModule } from "@kabane/extension";

/**
 * The extension was `recipes` until JCAB-646, and so were its tables and modules. This module's
 * one migration moves a device that ran it to the new names: the tables, the two version tables,
 * and the names the oplog, the parked ops and the recorded declarations hold. It must run before
 * the run and job modules read their version tables, so `modules.ts` registers it first; they
 * then find the history the old names recorded and continue from it. A device that never had the
 * old tables has nothing to move.
 *
 * This is the one place the extension writes core's sync and module bookkeeping by hand: core has
 * no way to rename a module. Op ids are left as they are, a backfill's `bf:recipes_…` included:
 * an op id is the op's identity on the log, not a table name to read.
 */
export namespace FromRecipes {
	const TABLES: readonly (readonly [string, string])[] = [
		["recipes_runs", "jobs_runs"],
		["recipes_jobs", "jobs_jobs"],
		["recipes_roots", "jobs_roots"],
		["recipes_attention", "jobs_attention"],
	];

	const MODULES: readonly (readonly [string, string])[] = [
		["recipes", "jobs-runs"],
		["recipes-jobs", "jobs"],
	];

	/** Core's name for a module's version table (`Modules.versionTable`); an extension imports no value. */
	const versionTable = (module: string): string =>
		`schema_migrations_${module.replaceAll("-", "_")}`;

	const exists = (db: Db, table: string): boolean =>
		db
			.query<{ one: number }, [string]>(
				"SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(table) !== null;

	/** A rename onto a table that already exists throws, so the migration rolls back. */
	const renameTable = (db: Db, from: string, to: string): void => {
		if (exists(db, from)) db.run(`ALTER TABLE ${from} RENAME TO ${to}`);
	};

	const migrate = (db: Db): void => {
		for (const [from, to] of TABLES) {
			renameTable(db, from, to);
			db.run("UPDATE sync_oplog SET tbl = ? WHERE tbl = ?", [to, from]);
			db.run(
				"UPDATE sync_parked SET tbl = ?, op = json_set(op, '$.tbl', ?) WHERE tbl = ?",
				[to, to, from],
			);
			db.run("UPDATE sync_parked_deletes SET tbl = ? WHERE tbl = ?", [
				to,
				from,
			]);
			db.run("UPDATE sync_quarantine SET tbl = ? WHERE tbl = ?", [to, from]);
		}
		for (const [from, to] of MODULES) {
			renameTable(db, versionTable(from), versionTable(to));
			db.run("UPDATE sync_oplog SET module = ? WHERE module = ?", [to, from]);
			db.run(
				"UPDATE sync_parked SET module = ?, op = json_set(op, '$.module.name', ?) WHERE module = ?",
				[to, to, from],
			);
			// The renamed module records its own declaration when it registers next in this pass.
			db.run("DELETE FROM module_declarations WHERE module = ?", [from]);
		}
	};

	export const module = (): KabaneModule => ({
		name: "jobs-from-recipes",
		migrations: [{ name: "rename-recipes", up: migrate }],
	});
}
