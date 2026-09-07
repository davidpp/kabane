/**
 * The Db port.
 *
 * Everything the storage layer needs from a SQLite engine, and nothing more.
 * The shape deliberately mirrors the `bun:sqlite` subset the storage code was
 * written against — `query(sql).get/all/run`, `run`, `exec`, `transaction` —
 * so the bun adapter is a thin pass-through and a Durable Object adapter can
 * implement the same five calls over `SqlStorage`.
 *
 * A `Db` is always handed to a callback by a `DbProvider` and is only valid for
 * the duration of that callback. Nothing holds one across an await boundary
 * that the provider does not own.
 */

import type { Result } from "../result";

/** A value that can be bound to a SQL parameter. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** A row as returned by the engine, keyed by column name. */
export type Row = Record<string, unknown>;

/** What a write reports back. */
export type Changes = { changes: number };

/**
 * A prepared statement. Parameters are positional and bound per call, which
 * is how every call site in storage already uses them.
 */
export interface DbStatement<T = Row, P extends SqlValue[] = SqlValue[]> {
	get(...params: P): T | null;
	all(...params: P): T[];
	run(...params: P): Changes;
}

export interface Db {
	/** Prepare a statement for one or more parameterized executions. */
	query<T = Row, P extends SqlValue[] = SqlValue[]>(
		sql: string,
	): DbStatement<T, P>;
	/** Alias of `query` — kept because one hot loop in sync uses it by name. */
	prepare<T = Row, P extends SqlValue[] = SqlValue[]>(
		sql: string,
	): DbStatement<T, P>;
	/** Execute one statement with optional positional bindings. */
	run(sql: string, params?: SqlValue[]): Changes;
	/** Execute a multi-statement SQL script. No bindings. */
	exec(sql: string): void;
	/**
	 * Wrap `fn` in a transaction. Returns the wrapped function, matching
	 * `bun:sqlite`; a throw inside `fn` rolls back, a return commits.
	 */
	transaction<T>(fn: () => T): () => T;
}

/**
 * Opens a database for one unit of work and closes it afterwards.
 *
 * `basePath` is an opaque handle the provider interprets: a directory for the
 * bun adapter, ignored by a Durable Object that owns exactly one database.
 * Storage functions carry it through unchanged so a host can keep addressing
 * databases the way it already does.
 */
export interface DbProvider {
	withDb<T>(
		basePath: string,
		fn: (db: Db) => T | Promise<T>,
	): Promise<Result<T>>;
	/**
	 * Optional: run `fn` inside one write transaction with awaits allowed
	 * between statements. When absent the runtime issues BEGIN IMMEDIATE /
	 * COMMIT itself, which every engine that accepts those statements gets for
	 * free; an engine that does not (Durable Object SQLite) implements this.
	 */
	atomic?<T>(
		basePath: string,
		fn: (db: Db) => T | Promise<T>,
	): Promise<Result<T>>;
}
