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

const NOW = "2026-07-18T12:00:00.000Z";

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
		// implicitly.
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
		expect(upstreamDefault?.dflt_value).toBe("'shared'");

		// And the migrated table writes like a fresh one.
		const updated = await Planner.updateTask(base, seeded.value.id, {
			title: "after migration",
		});
		expect(updated.ok).toBe(true);
	});

	it("drops the linked-issue snapshot columns and releases the held rows", async () => {
		const task = await Planner.addTask(base, { title: "root" });
		if (!task.ok) throw task.error;

		// Rebuild the table as a snapshot-era database: the four content columns
		// back, visibility pinned private, one row already in it.
		await withDb((db) => {
			db.run(`DROP TABLE ${TABLES.upstream_links}`);
			db.run(
				`CREATE TABLE ${TABLES.upstream_links} (
				   id TEXT PRIMARY KEY,
				   task_id TEXT NOT NULL REFERENCES ${TABLES.tasks}(id) ON DELETE CASCADE,
				   provider TEXT NOT NULL,
				   external_id TEXT NOT NULL,
				   identifier TEXT,
				   url TEXT NOT NULL,
				   title TEXT NOT NULL,
				   description TEXT,
				   state TEXT,
				   external_updated_at TEXT,
				   refreshed_at TEXT NOT NULL,
				   created_at TEXT NOT NULL,
				   updated_at TEXT NOT NULL,
				   visibility TEXT NOT NULL DEFAULT 'private',
				   UNIQUE(task_id, provider, external_id)
				 )`,
			);
			db.run(
				`INSERT INTO ${TABLES.upstream_links}
				   (id, task_id, provider, external_id, identifier, url, title,
				    description, state, external_updated_at, refreshed_at,
				    created_at, updated_at)
				 VALUES ('01LINK', ?, 'linear', 'linear-uuid', 'ENG-123',
				         'https://linear.app/acme/issue/ENG-123/x', 'Team feature',
				         'cached body', 'In Progress', ?, ?, ?, ?)`,
				[task.value.id, NOW, NOW, NOW, NOW],
			);
		});

		const reinit = await Planner.init(base);
		expect(reinit.ok).toBe(true);

		for (const column of [
			"description",
			"state",
			"external_updated_at",
			"refreshed_at",
		]) {
			expect(
				await withDb((db) => columnExists(db, TABLES.upstream_links, column)),
			).toBe(false);
		}

		const row = await withDb((db) =>
			db
				.query<{ visibility: string; title: string }, [string]>(
					`SELECT visibility, title FROM ${TABLES.upstream_links} WHERE id = ?`,
				)
				.get("01LINK"),
		);
		expect(row).toEqual({ visibility: "shared", title: "Team feature" });
	});
});
