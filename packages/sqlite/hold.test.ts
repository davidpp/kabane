/**
 * The idle connection the provider keeps beside its units of work. Without it, each unit is the
 * last connection to close: SQLite checkpoints, deletes the WAL and its index, and the next open
 * writes them again, which a polling board did several times a second.
 */

import { Database } from "bun:sqlite";
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

	it("holds no lock: another connection writes and checkpoints the WAL away while it is held", async () => {
		const provider = SqliteDb.provider({ dbName: DB_NAME });
		expect((await unit(provider)).ok).toBe(true);

		const other = new Database(dbPath);
		try {
			other.run("PRAGMA busy_timeout = 0");
			other.run("INSERT INTO t (v) VALUES (?)", ["y"]);
			const checkpoint = other
				.query<{ busy: number; log: number; checkpointed: number }, []>(
					"PRAGMA wal_checkpoint(TRUNCATE)",
				)
				.get();
			expect(checkpoint).toEqual({ busy: 0, log: 0, checkpointed: 0 });
		} finally {
			other.close();
		}
		expect(walBytes(dbPath)).toBe(0);
	});

	it("lets a one-shot process exit at once rather than when the hold lapses", async () => {
		const script = `
			const { SqliteDb } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
			const done = await SqliteDb.provider({ dbName: ${JSON.stringify(DB_NAME)} }).withDb(
				${JSON.stringify(base)},
				(db) => db.exec("CREATE TABLE t (v TEXT)"),
			);
			if (!done.ok) process.exitCode = 1;
		`;
		const started = performance.now();
		const proc = Bun.spawn([process.execPath, "-e", script], {
			stderr: "inherit",
			// The default hold is 30 s; a timer that kept the process alive would run into this.
			timeout: 5_000,
		});
		expect(await proc.exited).toBe(0);
		expect(performance.now() - started).toBeLessThan(5_000);
	}, 10_000);
});
