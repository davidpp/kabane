/**
 * Planner Sync — data modules.
 *
 * A module (`module.ts`) brings its own migrations and replicated tables. The
 * one defined here is the smallest real one: a row-lww table of notes, each
 * hanging off a task. Two devices share one in-process relay, and since the
 * module registry is process-wide, every step first registers the modules the
 * device acting has (`as`).
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import { ulid } from "ulid";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import { physicalTable } from "../db/tables";
import type { KabaneModule } from "../module";
import { Runtime, withDb as runWithDb } from "../runtime";
import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Migrations } from "../storage/migrations";
import { Oplog } from "../storage/oplog";
import { configureTestRuntime, TEST_DB_NAME } from "../testing";
import { Backfill } from "./backfill";
import { LocalRelay, type Relay } from "./local-relay";
import { Sync } from "./namespace";
import type { SyncTransport } from "./transport";

type Row = Record<string, unknown>;

type Device = {
	base: string;
	transport: SyncTransport;
	modules: readonly KabaneModule[];
};

// ============================================================
// The module
// ============================================================

const NOTES = "task_notes";
const notesTable = (): string => physicalTable(NOTES);

const CREATE_NOTES: Migrate.Migration = {
	name: "create-task-notes",
	up: (db) =>
		db.run(
			`CREATE TABLE IF NOT EXISTS ${notesTable()} (
			   id TEXT PRIMARY KEY,
			   task_id TEXT NOT NULL REFERENCES ${TABLES.tasks}(id) ON DELETE CASCADE,
			   body TEXT NOT NULL,
			   updated_at TEXT NOT NULL,
			   updated_by TEXT,
			   version INTEGER NOT NULL DEFAULT 1,
			   visibility TEXT NOT NULL DEFAULT 'shared'
			 )`,
		),
};

const PIN_NOTES: Migrate.Migration = {
	name: "pin-task-notes",
	up: (db) =>
		db.run(
			`ALTER TABLE ${notesTable()} ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
		),
};

const notes = (
	migrations: readonly Migrate.Migration[] = [CREATE_NOTES],
): KabaneModule => ({
	name: "notes",
	migrations,
	syncTables: [
		{
			table: NOTES,
			family: "row-lww",
			clock: "updated_at",
			childOfTasks: true,
		},
	],
});

/** The module's storage, written the way core's is: write, then capture. */
const writeNote = (
	device: Device,
	note: { taskId: string; body: string; pinned?: number },
): Promise<string> => {
	const id = ulid();
	return as(device, (db) => {
		const pinned = note.pinned === undefined ? "" : ", pinned";
		db.run(
			`INSERT INTO ${notesTable()} (id, task_id, body, updated_at${pinned})
			 VALUES (?, ?, ?, ?${note.pinned === undefined ? "" : ", ?"})`,
			[
				id,
				note.taskId,
				note.body,
				new Date().toISOString(),
				...(note.pinned === undefined ? [] : [note.pinned]),
			],
		);
		Oplog.afterWrite(db, NOTES, "insert", id);
		return id;
	});
};

const editNote = (device: Device, id: string, body: string): Promise<void> =>
	as(device, (db) => {
		db.run(
			`UPDATE ${notesTable()} SET body = ?, version = version + 1, updated_at = ?
			 WHERE id = ?`,
			[body, new Date(Date.now() + 1).toISOString(), id],
		);
		Oplog.afterWrite(db, NOTES, "update", id);
	});

// ============================================================
// Harness
// ============================================================

let relay: Relay;
let bases: string[];

const register = (modules: readonly KabaneModule[]): void => {
	const configured = Runtime.configure({
		provider: SqliteDb.provider({ dbName: TEST_DB_NAME }),
		timezone: () => "UTC",
		modules,
	});
	if (!configured.ok) throw configured.error;
};

/** Run `fn` against `device`'s database, with `device`'s modules registered. */
const as = async <T>(device: Device, fn: (db: Db) => T): Promise<T> => {
	register(device.modules);
	const result = await runWithDb(device.base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const createDevice = async (
	deviceId: string,
	modules: readonly KabaneModule[],
): Promise<Device> => {
	const base = join(
		tmpdir(),
		`cabane-module-${deviceId}-${crypto.randomUUID()}`,
	);
	mkdirSync(base, { recursive: true });
	bases.push(base);
	const device = {
		base,
		transport: LocalRelay.transportFor(relay, deviceId),
		modules,
	};
	await boot(device);
	await as(device, (db) => {
		const armed = Oplog.initDevice(db, deviceId);
		if (!armed.ok) throw armed.error;
	});
	return device;
};

/** What every host does at startup: register, then `Planner.init`. */
const boot = async (device: Device): Promise<void> => {
	register(device.modules);
	const init = await Planner.init(device.base);
	if (!init.ok) throw init.error;
};

const push = async (device: Device) => {
	register(device.modules);
	const pushed = await Sync.push(device.base, device.transport);
	if (!pushed.ok) throw pushed.error;
	return pushed.value;
};

const pull = async (device: Device) => {
	register(device.modules);
	const pulled = await Sync.pull(device.base, device.transport);
	if (!pulled.ok) throw pulled.error;
	return pulled.value;
};

const status = async (device: Device) => {
	register(device.modules);
	const s = await Sync.status(device.base);
	if (!s.ok) throw s.error;
	return s.value;
};

const addTask = async (device: Device, title: string): Promise<string> => {
	register(device.modules);
	const added = await Planner.addTask(device.base, { title });
	if (!added.ok) throw added.error;
	return added.value.id;
};

const titles = (device: Device): Promise<string[]> =>
	as(device, (db) =>
		db
			.query<{ title: string }, []>(
				`SELECT title FROM ${TABLES.tasks} ORDER BY title`,
			)
			.all()
			.map((row) => row.title),
	);

const notesOn = (device: Device): Promise<Row[]> =>
	as(device, (db) =>
		db.query<Row, []>(`SELECT * FROM ${notesTable()} ORDER BY id`).all(),
	);

const tableExists = (device: Device, name: string): Promise<boolean> =>
	as(
		device,
		(db) =>
			db
				.query<{ one: number }, [string]>(
					"SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(name) !== null,
	);

beforeEach(() => {
	relay = LocalRelay.create();
	bases = [];
});

afterEach(() => {
	for (const base of bases) rmSync(base, { recursive: true, force: true });
});

// Every other test file in this process expects the default wiring back.
afterAll(() => configureTestRuntime());

// ============================================================
// Registration
// ============================================================

describe("registering modules", () => {
	afterEach(() => configureTestRuntime());

	const refused = (modules: readonly KabaneModule[]): string => {
		const configured = Runtime.configure({
			provider: SqliteDb.provider({ dbName: TEST_DB_NAME }),
			modules,
		});
		return configured.ok ? "" : configured.error.message;
	};

	it("defaults to none", () => {
		expect(Runtime.modules()).toEqual([]);
	});

	it("refuses two modules with one name", () => {
		expect(refused([notes(), notes()])).toContain(
			'two modules are named "notes"',
		);
	});

	it("refuses a table core already has", () => {
		const clash: KabaneModule = {
			name: "clash",
			syncTables: [{ table: "tasks", family: "row-lww", childOfTasks: false }],
		};
		expect(refused([clash])).toContain("already a core table");
	});

	it("refuses a table another module already has", () => {
		const twin: KabaneModule = { ...notes(), name: "twin" };
		expect(refused([notes(), twin])).toContain('a table of module "notes"');
	});

	it("refuses a natural-key family, whose key the contract cannot declare", () => {
		const keyed: KabaneModule = {
			name: "keyed",
			syncTables: [
				{ table: "keyed_rows", family: "natural-key-lww", childOfTasks: false },
			],
		};
		expect(refused([keyed])).toContain("needs a natural key");
	});

	it("refuses a table named like a module's migration table, whichever module registers first", () => {
		const squatter: KabaneModule = {
			name: "squatter",
			syncTables: [
				{
					table: "schema_migrations_notes",
					family: "append-only",
					childOfTasks: false,
				},
			],
		};
		expect(refused([squatter, notes()])).toContain(
			'the migration table of module "notes"',
		);
		expect(refused([notes(), squatter])).toContain(
			'the migration table of module "notes"',
		);
	});

	it("refuses a row-lww table without a clock, which could never converge", () => {
		const clockless: KabaneModule = {
			name: "clockless",
			syncTables: [
				{ table: "clockless_rows", family: "row-lww", childOfTasks: false },
			],
		};
		expect(refused([clockless])).toContain('"row-lww" needs a clock column');
	});

	it("changes nothing when it refuses", () => {
		register([notes()]);
		expect(refused([notes(), notes()])).not.toBe("");
		expect(Runtime.modules().map((module) => module.name)).toEqual(["notes"]);
	});
});

// ============================================================
// Migrations and capture
// ============================================================

describe("a module's migrations", () => {
	it("apply on Planner.init after core's, recorded in the module's own version table", async () => {
		const alpha = await createDevice("alpha", [
			notes([CREATE_NOTES, PIN_NOTES]),
		]);

		expect(await tableExists(alpha, NOTES)).toBe(true);
		const versions = await as(alpha, (db) => ({
			core: Migrate.current(db),
			notes: db
				.query<{ version: number; name: string }, []>(
					`SELECT version, name FROM ${physicalTable("schema_migrations_notes")} ORDER BY version`,
				)
				.all(),
		}));
		expect(versions.core).toBe(Migrations.SCHEMA_VERSION);
		expect(versions.notes).toEqual([
			{ version: 1, name: "create-task-notes" },
			{ version: 2, name: "pin-task-notes" },
		]);
	});

	it("refuse a database a newer build of the module migrated, naming the module", async () => {
		const alpha = await createDevice("alpha", [
			notes([CREATE_NOTES, PIN_NOTES]),
		]);
		register([notes([CREATE_NOTES])]);
		const init = await Planner.init(alpha.base);
		expect(init.ok).toBe(false);
		expect(init.ok ? "" : init.error.message).toContain('module "notes"');
		expect(init.ok ? "" : init.error.message).toContain("update kabane");
	});

	it("refuse it from a build of the module with no migrations at all", async () => {
		const alpha = await createDevice("alpha", [notes([CREATE_NOTES])]);
		for (const bare of [
			notes([]),
			{ name: "notes", syncTables: notes().syncTables },
		]) {
			register([bare]);
			const init = await Planner.init(alpha.base);
			expect(init.ok ? "" : init.error.message).toContain('module "notes"');
		}
	});
});

describe("capturing a module table", () => {
	it("tags the op with the module's name and version, and keeps core's schema", async () => {
		const alpha = await createDevice("alpha", [
			notes([CREATE_NOTES, PIN_NOTES]),
		]);
		const task = await addTask(alpha, "parent");
		await writeNote(alpha, { taskId: task, body: "hello" });
		await push(alpha);

		const ops = LocalRelay.ops(relay);
		const note = ops.find((op) => op.tbl === NOTES);
		expect(note?.module).toEqual({ name: "notes", schema: 2 });
		expect(note?.schema).toBe(Migrations.SCHEMA_VERSION);
		expect(ops.find((op) => op.tbl === "tasks")?.module).toBeUndefined();
	});

	it("refuses a table no registered module declares", async () => {
		const alpha = await createDevice("alpha", [notes()]);
		const task = await addTask(alpha, "parent");
		const bare = { ...alpha, modules: [] };
		await expect(
			writeNote(bare, { taskId: task, body: "lost" }),
		).rejects.toThrow('Cannot capture a write to "task_notes"');
	});

	it("captures a task's notes as deletes before the task's own", async () => {
		const alpha = await createDevice("alpha", [notes()]);
		const task = await addTask(alpha, "doomed");
		const note = await writeNote(alpha, { taskId: task, body: "goes too" });
		register(alpha.modules);
		const deleted = await Planner.deleteTask(alpha.base, task);
		if (!deleted.ok) throw deleted.error;

		const deletes = await as(alpha, (db) =>
			db
				.query<{ tbl: string; row_id: string }, []>(
					`SELECT tbl, row_id FROM ${TABLES.sync_oplog} WHERE op = 'delete' ORDER BY seq`,
				)
				.all(),
		);
		expect(deletes).toEqual([
			{ tbl: NOTES, row_id: note },
			{ tbl: "tasks", row_id: task },
		]);
	});

	it("backfills a module table after core's", async () => {
		// History written before sync was armed, which is what backfill is for.
		const base = join(
			tmpdir(),
			`cabane-module-backfill-${crypto.randomUUID()}`,
		);
		mkdirSync(base, { recursive: true });
		bases.push(base);
		const alpha = {
			base,
			transport: LocalRelay.transportFor(relay, "alpha"),
			modules: [notes()],
		};
		await boot(alpha);
		const task = await addTask(alpha, "parent");
		const note = await writeNote(alpha, { taskId: task, body: "old" });
		await as(alpha, (db) => Oplog.initDevice(db, "alpha"));

		register(alpha.modules);
		const report = await Backfill.run(alpha.base);
		if (!report.ok) throw report.error;
		expect(report.value.byTable).toEqual({ tasks: 1, [NOTES]: 1 });

		const ids = await as(alpha, (db) =>
			db
				.query<{ op_id: string }, []>(
					`SELECT op_id FROM ${TABLES.sync_oplog} ORDER BY seq`,
				)
				.all()
				.map((row) => row.op_id),
		);
		expect(ids).toEqual([`bf:tasks:${task}:v1`, `bf:${NOTES}:${note}:v1`]);
	});
});

// ============================================================
// Park and replay
// ============================================================

describe("a device without the module", () => {
	it("parks the module's ops, keeps core flowing both ways, and applies them once it registers", async () => {
		const alpha = await createDevice("alpha", [notes()]);
		const beta = await createDevice("beta", []);

		const task = await addTask(alpha, "shared parent");
		const first = await writeNote(alpha, { taskId: task, body: "first" });
		const second = await writeNote(alpha, { taskId: task, body: "second" });
		await editNote(alpha, first, "first, edited");
		await push(alpha);

		const pulled = await pull(beta);
		expect(pulled.parked).toBe(3);
		expect(await titles(beta)).toEqual(["shared parent"]);
		expect(await tableExists(beta, NOTES)).toBe(false);
		expect((await status(beta)).parkedOps).toEqual({ notes: 3 });

		// Core keeps flowing both ways while the notes wait.
		await addTask(beta, "from beta");
		await push(beta);
		await addTask(alpha, "from alpha, later");
		await push(alpha);
		await pull(alpha);
		await pull(beta);
		expect(await titles(alpha)).toEqual(await titles(beta));
		expect(await titles(beta)).toHaveLength(3);

		// Beta updates to a build that ships the module.
		const upgraded = { ...beta, modules: [notes()] };
		await boot(upgraded);
		const replay = await pull(upgraded);
		expect(replay.replayed).toBe(3);
		expect(replay.parked).toBe(0);

		expect(await notesOn(upgraded)).toEqual(await notesOn(alpha));
		const rows = await notesOn(upgraded);
		expect(rows.map((row) => [row.id, row.body, row.version])).toEqual(
			[
				[first, "first, edited", 2],
				[second, "second", 1],
			].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		);
		expect((await status(upgraded)).parkedOps).toEqual({});

		// A second pass finds nothing left to replay.
		expect((await pull(upgraded)).replayed).toBe(0);
	});

	it("drops a parked note whose task was deleted meanwhile, as the cascade would have", async () => {
		const alpha = await createDevice("alpha", [notes()]);
		const beta = await createDevice("beta", []);

		const task = await addTask(alpha, "short-lived");
		await writeNote(alpha, { taskId: task, body: "orphaned" });
		await push(alpha);
		await pull(beta);

		register(beta.modules);
		const deleted = await Planner.deleteTask(beta.base, task);
		if (!deleted.ok) throw deleted.error;

		const upgraded = { ...beta, modules: [notes()] };
		await boot(upgraded);
		const replay = await pull(upgraded);
		expect(replay.replayed).toBe(1);
		expect(replay.skipped["orphan-parent"]).toBe(1);
		expect(await notesOn(upgraded)).toEqual([]);
		expect((await status(upgraded)).parkedOps).toEqual({});
	});
});

describe("a device on an older version of the module", () => {
	it("parks ops from the newer version and applies them after it migrates", async () => {
		const alpha = await createDevice("alpha", [
			notes([CREATE_NOTES, PIN_NOTES]),
		]);
		const beta = await createDevice("beta", [notes([CREATE_NOTES])]);

		const task = await addTask(alpha, "parent");
		const pinned = await writeNote(alpha, {
			taskId: task,
			body: "pinned",
			pinned: 1,
		});
		await push(alpha);

		const pulled = await pull(beta);
		expect(pulled.parked).toBe(1);
		expect(await titles(beta)).toEqual(["parent"]);
		expect(await notesOn(beta)).toEqual([]);

		// Beta's own notes, on the older version, still reach alpha meanwhile.
		const fromBeta = await writeNote(beta, { taskId: task, body: "from beta" });
		await push(beta);
		await pull(alpha);
		expect((await notesOn(alpha)).map((row) => row.id)).toContain(fromBeta);

		const migrated = { ...beta, modules: [notes([CREATE_NOTES, PIN_NOTES])] };
		await boot(migrated);
		const replay = await pull(migrated);
		expect(replay.replayed).toBe(1);

		const rows = await notesOn(migrated);
		expect(rows.find((row) => row.id === pinned)).toMatchObject({
			body: "pinned",
			pinned: 1,
		});
		expect(rows).toEqual(await notesOn(alpha));
		expect((await status(migrated)).parkedOps).toEqual({});
	});
});

// ============================================================
// A database from before the seam
// ============================================================

describe("a database from before data modules", () => {
	it("opens, gains the parked-ops table, and syncs unchanged", async () => {
		const alpha = await createDevice("alpha", []);
		const beta = await createDevice("beta", []);
		// Beta as the release before this one left it: no parked-ops table and
		// no record of the migration that makes it.
		await as(beta, (db) => {
			db.run(`DROP TABLE ${TABLES.sync_parked}`);
			db.run(
				`DELETE FROM ${TABLES.schema_migrations} WHERE name = 'sync-parked'`,
			);
		});
		await addTask(beta, "already here");

		await boot(beta);
		expect(await tableExists(beta, TABLES.sync_parked)).toBe(true);
		expect((await status(beta)).parkedOps).toEqual({});

		await addTask(alpha, "from alpha");
		await push(alpha);
		await push(beta);
		await pull(alpha);
		const pulled = await pull(beta);
		expect(pulled.parked).toBe(0);
		expect(await titles(beta)).toEqual(["already here", "from alpha"]);
		expect(await titles(alpha)).toEqual(await titles(beta));
	});
});
