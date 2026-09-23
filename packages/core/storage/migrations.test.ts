/**
 * Storage — the migration list on real databases.
 *
 * The repeat failure in this codebase is new code booting on an old database
 * (see the jake-db-migrations note): a column the DDL declares but the live
 * table lacks. A pre-release database is modelled the way one really looks:
 * the current schema with what an older build lacked taken away, and no
 * version table, because the runner that writes it did not exist yet.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import { physicalTable } from "../db/tables";
import { withDb as runWithDb } from "../runtime";
import { configureTestRuntime } from "../testing";
import { columnExists, TABLES } from "./helpers";
import { Planner } from "./index";
import { Migrations } from "./migrations";

let base: string;

const withDb = async <T>(fn: (db: Db) => T, at = base): Promise<T> => {
	const result = await runWithDb(at, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const freshBase = (label: string): string => {
	const dir = join(
		tmpdir(),
		`cabane-migrations-${label}-${crypto.randomUUID()}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const mustInit = async (at: string): Promise<void> => {
	const init = await Planner.init(at);
	if (!init.ok) throw init.error;
};

/** Make a current database look like one from before the runner. */
const forgetVersion = (db: Db): void => {
	db.run(`DROP TABLE ${TABLES.schema_migrations}`);
};

const versionRows = (at = base) =>
	withDb(
		(db) =>
			db
				.query<{ version: number; name: string }, []>(
					`SELECT version, name FROM ${TABLES.schema_migrations} ORDER BY version`,
				)
				.all(),
		at,
	);

/**
 * Everything a schema is, independent of column order: an ALTER appends a
 * column at the end where the DDL declares it in the middle, and SQLite's own
 * autoindexes follow from UNIQUE written inline versus added later.
 */
const schemaSignature = (at: string) =>
	withDb((db) => {
		const objects = db
			.query<{ type: string; name: string }, []>(
				`SELECT type, name FROM sqlite_master
				  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
			)
			.all();
		const columns = Object.fromEntries(
			objects
				.filter((o) => o.type === "table")
				.map((t) => [
					t.name,
					db
						.query<
							{
								name: string;
								type: string;
								notnull: number;
								dflt_value: string | null;
							},
							[]
						>(
							`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${t.name}') ORDER BY name`,
						)
						.all(),
				]),
		);
		return { objects: objects.map((o) => `${o.type}:${o.name}`), columns };
	}, at);

/** What a database reports once every migration has run. */
const ALL_VERSIONS = Migrations.LIST.map((m, i) => ({
	version: i + 1,
	name: m.name,
}));

const tableNames = (at = base) =>
	withDb(
		(db) =>
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all()
				.map((r) => r.name),
		at,
	);

const REPLICATION_COLUMNS = ["updated_by", "version", "visibility"] as const;

const NOW = "2026-07-18T12:00:00.000Z";

describe("Migrations on a fresh database", () => {
	beforeEach(async () => {
		base = freshBase("fresh");
		await mustInit(base);
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("records every migration once, and a second boot applies nothing", async () => {
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		await mustInit(base);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const again = await withDb((db) => Migrations.apply(db));
		expect(again).toEqual({
			ok: true,
			value: {
				from: Migrations.SCHEMA_VERSION,
				to: Migrations.SCHEMA_VERSION,
				applied: [],
			},
		});
	});

	it("ends at the same schema as a pre-release database brought up by the baseline", async () => {
		const upgraded = freshBase("upgraded");
		try {
			await mustInit(upgraded);
			await withDb(forgetVersion, upgraded);
			await mustInit(upgraded);
			expect(await versionRows(upgraded)).toEqual(ALL_VERSIONS);
			expect(await schemaSignature(upgraded)).toEqual(
				await schemaSignature(base),
			);
		} finally {
			rmSync(upgraded, { recursive: true, force: true });
		}
	});

	it("leaves a linked issue made private on purpose private across boots", async () => {
		const task = await Planner.addTask(base, { title: "root" });
		if (!task.ok) throw task.error;
		await withDb((db) =>
			db.run(
				`INSERT INTO ${TABLES.upstream_links}
				   (id, task_id, provider, external_id, identifier, url, title,
				    created_at, updated_at, visibility)
				 VALUES ('01PRIVATE', ?, 'linear', 'uuid', 'ENG-9',
				         'https://linear.app/acme/issue/ENG-9/x', 'Private', ?, ?, 'private')`,
				[task.value.id, NOW, NOW],
			),
		);

		await mustInit(base);
		await mustInit(base);

		const row = await withDb((db) =>
			db
				.query<{ visibility: string }, [string]>(
					`SELECT visibility FROM ${TABLES.upstream_links} WHERE id = ?`,
				)
				.get("01PRIVATE"),
		);
		expect(row?.visibility).toBe("private");
	});

	it("refuses a database a newer cabane has migrated, and says to update", async () => {
		await withDb((db) =>
			db.run(
				`INSERT INTO ${TABLES.schema_migrations} (version, name, applied_at) VALUES (?, 'from-the-future', ?)`,
				[Migrations.SCHEMA_VERSION + 1, NOW],
			),
		);
		const init = await Planner.init(base);
		expect(init.ok).toBe(false);
		expect(init.ok ? "" : init.error.message).toContain("update cabane");
	});
});

describe("Migrations on a pre-release database", () => {
	beforeEach(async () => {
		base = freshBase("pre-release");
		await mustInit(base);
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
			forgetVersion(db);
		});
		expect(
			await withDb((db) => columnExists(db, TABLES.tasks, "version")),
		).toBe(false);

		const reinit = await Planner.init(base);
		expect(reinit.ok).toBe(true);
		expect(await versionRows()).toEqual(ALL_VERSIONS);

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
			forgetVersion(db);
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

describe("Migrations on a device stamped at the baseline", () => {
	beforeEach(async () => {
		base = freshBase("stamped");
		// What David's devices are after their first boot on the runner: version 1
		// and nothing above it.
		await withDb((db) => {
			const stamped = Migrate.run(db, Migrations.LIST.slice(0, 1));
			if (!stamped.ok) throw stamped.error;
		});
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("drops the retired tables and keeps every live row", async () => {
		const task = await Planner.addTask(base, { title: "keeps" });
		if (!task.ok) throw task.error;
		const comment = await Planner.addComment(base, {
			taskId: task.value.id,
			author: "david",
			authorType: "human",
			content: "keeps too",
		});
		if (!comment.ok) throw comment.error;
		await withDb((db) =>
			db.run(
				`INSERT INTO ${physicalTable("proposals")}
				   (id, action, confidence, summary, payload, created_at, updated_at)
				 VALUES ('01PROPOSAL', 'ask_question', 0.9, 'retired', '{}', ?, ?)`,
				[NOW, NOW],
			),
		);
		await withDb((db) =>
			db.run(
				`INSERT INTO ${physicalTable("focus_lists")} (id, period, created_at, updated_at)
				 VALUES ('01FOCUS', 'daily', ?, ?)`,
				[NOW, NOW],
			),
		);
		await withDb((db) =>
			db.run(
				`INSERT INTO ${physicalTable("task_activity")}
				   (id, task_id, event_type, actor, actor_type, timestamp)
				 VALUES ('01ACTIVITY', ?, 'short_id_renamed', 'sync', 'ai', ?)`,
				[task.value.id, NOW],
			),
		);

		await mustInit(base);

		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const tables = await tableNames();
		for (const retired of [
			"proposals",
			"proposals_fts",
			"focus_lists",
			"task_activity",
		]) {
			expect(tables).not.toContain(retired);
		}
		const kept = await Planner.getTask(base, task.value.id);
		expect(kept.ok && kept.value?.title).toBe("keeps");
		const comments = await Planner.getComments(base, task.value.id);
		expect(comments.ok && comments.value.map((c) => c.content)).toEqual([
			"keeps too",
		]);
		const found = await Planner.searchTasks(base, "keeps");
		expect(found.ok && found.value.map((t) => t.id)).toEqual([task.value.id]);
	});
});

describe("Migrations with Jake's table prefix", () => {
	afterEach(() => {
		configureTestRuntime();
		rmSync(base, { recursive: true, force: true });
	});

	it("keeps its version table behind the prefix too", async () => {
		configureTestRuntime("planner_");
		base = freshBase("prefixed");
		await mustInit(base);
		const names = await withDb((db) =>
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%schema_migrations'",
				)
				.all()
				.map((r) => r.name),
		);
		expect(names).toEqual(["planner_schema_migrations"]);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
	});
});

describe("Migrations when several processes boot one database at once", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("applies the baseline exactly once and every process boots", async () => {
		base = freshBase("concurrent");
		const core = join(import.meta.dir, "..", "index.ts");
		const sqlite = join(import.meta.dir, "..", "..", "sqlite", "index.ts");
		const script = `
			import { Planner, Runtime } from ${JSON.stringify(core)};
			import { SqliteDb } from ${JSON.stringify(sqlite)};
			Runtime.configure({ provider: SqliteDb.provider({ dbName: "cabane.db" }) });
			const init = await Planner.init(${JSON.stringify(base)});
			if (!init.ok) { console.error(init.error.message); process.exit(1); }
		`;
		const children = Array.from({ length: 4 }, () =>
			Bun.spawn(["bun", "-e", script], { stderr: "pipe" }),
		);
		const codes = await Promise.all(children.map((child) => child.exited));
		const errors = await Promise.all(
			children.map((child) => new Response(child.stderr).text()),
		);
		expect({ codes, errors }).toEqual({
			codes: [0, 0, 0, 0],
			errors: ["", "", "", ""],
		});
		expect(await versionRows()).toEqual(ALL_VERSIONS);
	});
});
