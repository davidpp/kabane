/**
 * The idle connection the provider keeps beside its units of work. Without it, each unit is the
 * last connection to close: SQLite checkpoints, deletes the WAL and its index, and the next open
 * writes them again, which a polling board did several times a second.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "./index";

const DB_NAME = "hold.db";

// What the WAL holds: Apple's SQLite keeps an empty WAL file where others delete it.
const walBytes = (dbPath: string): number =>
	existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;

describe("the provider's held connection", () => {
	let base: string;
	let dbPath: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "kabane-hold-"));
		dbPath = SqliteDb.pathFor(base, DB_NAME);
	});
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	const unit = (provider: ReturnType<typeof SqliteDb.provider>) =>
		provider.withDb(base, (db) => {
			db.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
			db.run("INSERT INTO t (v) VALUES (?)", ["x"]);
		});

	it("keeps the WAL between units of work, so none closes as the last connection", async () => {
		const provider = SqliteDb.provider({ dbName: DB_NAME });
		expect((await unit(provider)).ok).toBe(true);
		expect(walBytes(dbPath)).toBeGreaterThan(0);
	});

	it("lets go once units stop coming, and closing last checkpoints the WAL", async () => {
		const provider = SqliteDb.provider({ dbName: DB_NAME, holdIdleMs: 20 });
		expect((await unit(provider)).ok).toBe(true);
		await Bun.sleep(100);
		expect(walBytes(dbPath)).toBe(0);
	});
});
