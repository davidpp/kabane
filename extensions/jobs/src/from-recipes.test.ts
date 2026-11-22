// The rename from `recipes` over a real database: a device laid out as the recipes extension left
// it, with captured, parked and quarantined ops, opened by the jobs extension's modules.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	err,
	type KabaneModule,
	ok,
	Oplog,
	Planner,
	type Result,
	tryCatch,
	trySync,
	withDb,
} from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { createHostStore } from "@kabane/extension";
import { z } from "zod";
import modules from "../modules";
import { Jobs } from "./jobs";
import { Kabane } from "./result";
import { Runs } from "./runs";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const NOW = "2026-11-20T10:00:00.000Z";
const RUN = "01M7JT0TFJB7MF38VYDWCG8PKX";
const PARKED_RUN = "01M7JT0TFJB7MF38VYDWCG8PKY";

const step = (name: string): Migrate => ({ name, up: () => {} });
type Migrate = NonNullable<KabaneModule["migrations"]>[number];

/** The recipes extension's two modules as they last shipped: their tables' final shape, 3 and 5 versions. */
const RECIPES: KabaneModule[] = [
	{
		name: "recipes",
		migrations: [
			{
				name: "create-recipes-runs",
				up: (db) =>
					db.run(
						`CREATE TABLE recipes_runs (
						   id TEXT PRIMARY KEY, recipe TEXT NOT NULL, recipe_hash TEXT NOT NULL,
						   target_kind TEXT, target_id TEXT, scope_uri TEXT NOT NULL, dir TEXT NOT NULL,
						   machine TEXT NOT NULL, cwd TEXT NOT NULL, runtime TEXT NOT NULL,
						   session TEXT NOT NULL, inputs TEXT NOT NULL, state TEXT NOT NULL,
						   started_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL,
						   updated_by TEXT, version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared', harness TEXT
						 )`,
					),
			},
			step("add-recipes-runs-harness"),
			step("actor-scheme"),
		],
		syncTables: [
			{
				table: "recipes_runs",
				family: "row-lww",
				clock: "updated_at",
				childOfTasks: false,
			},
		],
	},
	{
		name: "recipes-jobs",
		migrations: [
			{
				name: "create-recipes-jobs",
				up: (db) => {
					db.run(
						`CREATE TABLE recipes_jobs (
						   id TEXT PRIMARY KEY,
						   task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
						   schedule TEXT NOT NULL, recipe TEXT NOT NULL, inputs TEXT NOT NULL,
						   harness TEXT, last_fired_at TEXT, created_at TEXT NOT NULL,
						   updated_at TEXT NOT NULL, updated_by TEXT,
						   version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared',
						   session TEXT NOT NULL DEFAULT 'fresh', "check" TEXT
						 )`,
					);
					db.run(
						"CREATE TABLE recipes_roots (scope_uri TEXT PRIMARY KEY, root TEXT NOT NULL, updated_at TEXT NOT NULL)",
					);
					db.run(
						"CREATE TABLE recipes_attention (run_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)",
					);
				},
			},
			step("add-recipes-jobs-session"),
			step("create-recipes-attention"),
			step("add-recipes-jobs-check"),
			step("actor-scheme"),
		],
		syncTables: [
			{
				table: "recipes_jobs",
				family: "row-lww",
				clock: "updated_at",
				childOfTasks: true,
			},
		],
	},
];

let home: string;
let taskId: string;

/** A device the recipes extension left: a run, a job, a folder, an attention state, their ops. */
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "jobs-from-recipes-"));
	configureTestRuntime({ modules: RECIPES });
	value(await Planner.init(home));
	value(value(await withDb(home, (db) => Oplog.initDevice(db, "here"))));
	taskId = value(
		await Planner.addTask(home, { title: "Morning wiki", kind: "job" }),
	).id;
	value(
		await withDb(home, (db) => {
			db.run(
				`INSERT INTO recipes_runs (id, recipe, recipe_hash, scope_uri, dir, machine, cwd, runtime,
				   session, inputs, state, started_at, updated_at, updated_by)
				 VALUES (?, 'wiki', 'abc123abc123', 'kabane://scope/s', '', 'here', '/repo', 'hc',
				   'wiki-1', '{}', 'ended', ?, ?, 'kabane://actor/human/t')`,
				[RUN, NOW, NOW],
			);
			Oplog.afterWrite(db, "recipes_runs", "insert", RUN);
			db.run(
				`INSERT INTO recipes_jobs (id, task_id, schedule, recipe, inputs, created_at, updated_at)
				 VALUES (?, ?, '0 9 * * *', 'wiki', '{}', ?, ?)`,
				[taskId, taskId, NOW, NOW],
			);
			Oplog.afterWrite(db, "recipes_jobs", "insert", taskId);
			db.run(
				"INSERT INTO recipes_roots (scope_uri, root, updated_at) VALUES ('kabane://scope/s', '/repo', ?)",
				[NOW],
			);
			db.run(
				"INSERT INTO recipes_attention (run_id, state, updated_at) VALUES (?, 'ended', ?)",
				[RUN, NOW],
			);
			// Another device's run, parked here as for a module this device ran at an older version.
			const parked = {
				opId: "remote-1",
				deviceId: "there",
				tbl: "recipes_runs",
				rowId: PARKED_RUN,
				op: "insert",
				module: { name: "recipes", schema: 3 },
				payload: { id: PARKED_RUN },
			};
			db.run(
				`INSERT INTO sync_parked (op_id, server_seq, module, module_schema, tbl, row_id, op, parked_at)
				 VALUES ('remote-1', 7, 'recipes', 3, 'recipes_runs', ?, ?, ?)`,
				[PARKED_RUN, JSON.stringify(parked), NOW],
			);
			db.run(
				"INSERT INTO sync_parked_deletes (tbl, row_id, deleted_at) VALUES ('recipes_jobs', 'gone', ?)",
				[NOW],
			);
			db.run(
				`INSERT INTO sync_quarantine (op_id, tbl, row_id, bytes, reason, quarantined_at)
				 VALUES ('big-1', 'recipes_runs', ?, 9, 'too large', ?)`,
				[RUN, NOW],
			);
		}),
	);
});

afterEach(() => {
	configureTestRuntime();
	rmSync(home, { recursive: true, force: true });
});

const read = <T>(sql: string): Promise<T[]> =>
	withDb(home, (db) => db.query<T, []>(sql).all()).then(value);

/** Every table, its rows and the schema's names, for comparing a database before and after. */
const dump = async (): Promise<string> => {
	const names = await read<{ type: string; name: string }>(
		"SELECT type, name FROM sqlite_master ORDER BY type, name",
	);
	const rows: Record<string, unknown> = {};
	for (const { type, name } of names)
		if (type === "table" && !name.startsWith("sqlite_"))
			rows[name] = await read(`SELECT * FROM "${name}"`);
	return JSON.stringify({ names, rows });
};

it("moves a recipes device's tables, versions, ops and declarations to the jobs names", async () => {
	configureTestRuntime({ modules: modules() });
	value(await Planner.init(home));

	expect(
		await read<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE name LIKE '%recipes%' AND name != 'schema_migrations_jobs_from_recipes'",
		),
	).toEqual([]);
	for (const table of [
		"jobs_runs",
		"jobs_jobs",
		"jobs_roots",
		"jobs_attention",
	])
		expect(
			await read<{ n: number }>(`SELECT count(*) AS n FROM ${table}`),
		).toEqual([{ n: 1 }]);
	// The history the old names recorded carries on: nothing re-ran, nothing is newer.
	expect(
		await read<{ v: number }>(
			"SELECT max(version) AS v FROM schema_migrations_jobs_runs",
		),
	).toEqual([{ v: 3 }]);
	expect(
		await read<{ v: number }>(
			"SELECT max(version) AS v FROM schema_migrations_jobs",
		),
	).toEqual([{ v: 5 }]);
	expect(
		await read(
			"SELECT tbl, module, module_schema FROM sync_oplog ORDER BY seq",
		),
	).toEqual([
		{ tbl: "tasks", module: null, module_schema: null },
		{ tbl: "jobs_runs", module: "jobs-runs", module_schema: 3 },
		{ tbl: "jobs_jobs", module: "jobs", module_schema: 5 },
	]);
	const [parked] = await read<{ tbl: string; module: string; op: string }>(
		"SELECT tbl, module, op FROM sync_parked",
	);
	expect(parked).toMatchObject({ tbl: "jobs_runs", module: "jobs-runs" });
	expect(JSON.parse(parked?.op ?? "")).toMatchObject({
		opId: "remote-1",
		tbl: "jobs_runs",
		module: { name: "jobs-runs", schema: 3 },
	});
	expect(await read("SELECT tbl FROM sync_parked_deletes")).toEqual([
		{ tbl: "jobs_jobs" },
	]);
	expect(await read("SELECT tbl FROM sync_quarantine")).toEqual([
		{ tbl: "jobs_runs" },
	]);
	expect(
		await read(
			"SELECT tbl, module, module_schema FROM module_declarations ORDER BY tbl",
		),
	).toEqual([
		{ tbl: "jobs_jobs", module: "jobs", module_schema: 5 },
		{ tbl: "jobs_runs", module: "jobs-runs", module_schema: 3 },
	]);

	// The stores read the moved rows.
	const host = {
		store: createHostStore(
			() => home,
			() => ["jobs_runs", "jobs_jobs"],
			"jobs test",
		),
		z,
	};
	expect(value(await Runs.list(host, undefined)).map((run) => run.id)).toEqual([
		RUN,
	]);
	expect(value(await Jobs.all(host)).map((job) => job.taskId)).toEqual([
		taskId,
	]);

	// A second open changes nothing.
	const once = await dump();
	value(await Planner.init(home));
	expect(await dump()).toBe(once);
});
