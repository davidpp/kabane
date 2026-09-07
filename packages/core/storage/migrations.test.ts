/**
 * Storage — replication columns on a database that predates them.
 *
 * The repeat failure in this codebase is new code booting on an old database
 * (see the jake-db-migrations note): a column the DDL declares but the live
 * table lacks. This test builds that old table by dropping the columns after
 * init, then proves a second init restores them through `runMigrations`.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";
import { columnExists, TABLES } from "./helpers";
import { Planner } from "./index";

let base: string;

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const REPLICATION_COLUMNS = ["updated_by", "version", "visibility"] as const;

describe("runMigrations — replication columns", () => {
	beforeEach(async () => {
		base = join(tmpdir(), `cabane-migrations-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });
		const init = await Planner.init(base);
		if (!init.ok) throw init.error;
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("adds updated_by, version and visibility to a table created without them", async () => {
		const seeded = await Planner.addTask(base, { title: "pre-existing" });
		if (!seeded.ok) throw seeded.error;

		// Turn the table into what a trigger-era database has.
		await withDb((db) => {
			for (const column of REPLICATION_COLUMNS) {
				db.run(`ALTER TABLE ${TABLES.tasks} DROP COLUMN ${column}`);
				db.run(`ALTER TABLE ${TABLES.comments} DROP COLUMN ${column}`);
			}
			db.run(`ALTER TABLE ${TABLES.upstream_links} DROP COLUMN visibility`);
		});
		expect(
			await withDb((db) => columnExists(db, TABLES.tasks, "version")),
		).toBe(false);

		const reinit = await Planner.init(base);
		expect(reinit.ok).toBe(true);

		for (const column of REPLICATION_COLUMNS) {
			expect(await withDb((db) => columnExists(db, TABLES.tasks, column))).toBe(
				true,
			);
			expect(
				await withDb((db) => columnExists(db, TABLES.comments, column)),
			).toBe(true);
		}

		// Existing rows read as version 1 and shared, which is what they were
		// implicitly; upstream links come back private.
		const row = await withDb((db) =>
			db
				.query<
					{ version: number; visibility: string; updated_by: string | null },
					[string]
				>(
					`SELECT version, visibility, updated_by FROM ${TABLES.tasks} WHERE id = ?`,
				)
				.get(seeded.value.id),
		);
		expect(row).toEqual({ version: 1, visibility: "shared", updated_by: null });

		const upstreamDefault = await withDb((db) =>
			db
				.query<{ dflt_value: string }, []>(
					`SELECT dflt_value FROM pragma_table_info('${TABLES.upstream_links}') WHERE name = 'visibility'`,
				)
				.get(),
		);
		expect(upstreamDefault?.dflt_value).toBe("'private'");

		// And the migrated table writes like a fresh one.
		const updated = await Planner.updateTask(base, seeded.value.id, {
			title: "after migration",
		});
		expect(updated.ok).toBe(true);
	});
});
