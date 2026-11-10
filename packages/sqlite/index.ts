/**
 * @cabane/sqlite — the Db port over `bun:sqlite`.
 *
 * One file per database under a base directory, opened per unit of work and
 * closed afterwards (the pattern the storage layer was written for: no shared
 * handle, safe under concurrent processes). While units keep coming, one idle
 * connection per file stays open beside them so the WAL is not rebuilt on every
 * open (`hold` in the provider). WAL, foreign keys and a busy
 * timeout are set on every open; SQLITE_BUSY is retried with jittered
 * backoff before it surfaces as an error.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Changes,
	type Db,
	type DbProvider,
	type DbStatement,
	err,
	ok,
	type Result,
	type Row,
	type SqlValue,
	toError,
} from "@cabane/core";

export type SqliteProviderOptions = {
	/** File name inside `basePath`. Default `kabane.db`. */
	dbName?: string;
	/** SQLITE_BUSY retries before giving up. Default 3. */
	maxBusyRetries?: number;
	/** How long the idle connection outlives the last unit of work on its file. Default 30 s. */
	holdIdleMs?: number;
};

const RETRY_BASE_MS = 50;

const isBusyError = (e: unknown): boolean => {
	if (!(e instanceof Error)) return false;
	return (
		e.message.includes("database is locked") ||
		e.message.includes("SQLITE_BUSY") ||
		(e as { code?: string }).code === "SQLITE_BUSY"
	);
};

const backoffMs = (attempt: number): number =>
	RETRY_BASE_MS * 2 ** attempt + Math.random() * RETRY_BASE_MS;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * busy_timeout is set FIRST so the later pragmas (journal_mode = WAL takes a
 * brief lock) do not throw SQLITE_BUSY when a concurrent writer holds it.
 */
const applyPragmas = (db: Database): void => {
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA cache_size = -64000");
};

const bindings = (params: SqlValue[]): SQLQueryBindings[] =>
	params as SQLQueryBindings[];

const toChanges = (result: { changes: number | bigint }): Changes => ({
	changes: Number(result.changes),
});

const toStatement = <T, P extends SqlValue[]>(
	db: Database,
	sql: string,
): DbStatement<T, P> => {
	const statement = db.query<T, SQLQueryBindings[]>(sql);
	return {
		get: (...params: P) => statement.get(...bindings(params)) ?? null,
		all: (...params: P) => statement.all(...bindings(params)),
		run: (...params: P) => toChanges(statement.run(...bindings(params))),
	};
};

/** Adapt an open `bun:sqlite` handle to the port. */
export const adapt = (db: Database): Db => ({
	query: <T = Row, P extends SqlValue[] = SqlValue[]>(sql: string) =>
		toStatement<T, P>(db, sql),
	prepare: <T = Row, P extends SqlValue[] = SqlValue[]>(sql: string) =>
		toStatement<T, P>(db, sql),
	run: (sql, params) =>
		toChanges(params ? db.run(sql, bindings(params)) : db.run(sql)),
	exec: (sql) => {
		db.exec(sql);
	},
	transaction: <T>(fn: () => T) => {
		const wrapped = db.transaction(fn);
		return () => wrapped();
	},
});

const HOLD_IDLE_MS = 30_000;

type Held = { timer: ReturnType<typeof setTimeout> };

/**
 * The idle connection, attached to the WAL index by one read. None when it cannot be opened: it
 * only saves writes, so a unit of work never fails for want of it.
 */
const tryOpenHeld = (dbPath: string): Database | undefined => {
	try {
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA busy_timeout = 5000");
			db.run("PRAGMA schema_version");
			return db;
		} catch {
			db.close();
			return undefined;
		}
	} catch {
		return undefined;
	}
};

export namespace SqliteDb {
	/** Path of the database file the provider opens for `basePath`. */
	export const pathFor = (basePath: string, dbName = "kabane.db"): string =>
		join(basePath, dbName);

	export const provider = (options: SqliteProviderOptions = {}): DbProvider => {
		const dbName = options.dbName ?? "kabane.db";
		const maxBusyRetries = options.maxBusyRetries ?? 3;
		const holdIdleMs = options.holdIdleMs ?? HOLD_IDLE_MS;
		const held = new Map<string, Held>();

		// When the last connection to a WAL database closes, SQLite checkpoints it and the next open
		// rebuilds the shared-memory index from scratch: about 36 KB written per unit of work. A
		// process that polls (the board, a loop runner) did that several times a second, tens of GB a
		// day. One idle connection kept open while units keep coming means no unit is ever the last.
		// It holds no lock between statements, so it is still safe under concurrent processes; the
		// timer is unref'd, so a one-shot command exits as it did.
		const hold = (dbPath: string): void => {
			const current = held.get(dbPath);
			if (current) {
				current.timer.refresh();
				return;
			}
			const opened = tryOpenHeld(dbPath);
			if (!opened) return;
			const timer = setTimeout(() => {
				held.delete(dbPath);
				opened.close();
			}, holdIdleMs);
			timer.unref();
			held.set(dbPath, { timer });
		};

		return {
			withDb: async <T>(
				basePath: string,
				fn: (db: Db) => T | Promise<T>,
			): Promise<Result<T>> => {
				const dbPath = pathFor(basePath, dbName);

				for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
					try {
						mkdirSync(dirname(dbPath), { recursive: true });
						const db = new Database(dbPath, { create: true });
						try {
							applyPragmas(db);
							hold(dbPath);
							return ok(await fn(adapt(db)));
						} finally {
							db.close();
						}
					} catch (e) {
						if (isBusyError(e) && attempt < maxBusyRetries) {
							await sleep(backoffMs(attempt));
							continue;
						}
						return err(toError(e));
					}
				}
				return err(new Error("withDb: exhausted SQLITE_BUSY retries"));
			},
		};
	};
}
