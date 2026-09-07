/**
 * The Db port over Durable Object SQLite.
 *
 * One Durable Object owns exactly one database, so `basePath` is ignored: the
 * storage layer keeps addressing databases by path and the hub answers with
 * the only one it has.
 *
 * Three platform facts shape this file (verified against the sync PRD table
 * and the live pool-workers runtime):
 * - `BEGIN` / `SAVEPOINT` are refused. `transaction` is `transactionSync`, and
 *   `atomic` is the storage API's own `transaction` so an awaiting body still
 *   lands whole or not at all.
 * - `sql.exec` binds at most 100 parameters per statement. Callers that
 *   insert in bulk pass one JSON parameter and unpack it with `json_each`, as
 *   the log does; this adapter does not paper over the cap.
 * - A cursor's `rowsWritten` counts index writes too, so `changes` is read
 *   from SQLite's own `changes()` right after the statement, which is exact.
 */

import type {
	Changes,
	Db,
	DbProvider,
	DbStatement,
	Result,
	Row,
	SqlValue,
} from "@cabane/core";
import { err, ok, toError } from "@cabane/core";

/**
 * What `SqlStorage.exec` accepts. Booleans and bigints are ours to translate:
 * the port allows them, the platform does not.
 */
const bind = (params: SqlValue[]): SqlStorageValue[] =>
	params.map((p) => {
		if (typeof p === "boolean") return p ? 1 : 0;
		if (typeof p === "bigint") return Number(p);
		if (p instanceof Uint8Array) {
			return p.buffer.slice(
				p.byteOffset,
				p.byteOffset + p.byteLength,
			) as ArrayBuffer;
		}
		return p;
	});

const changesOf = (sql: SqlStorage): Changes => ({
	changes: sql.exec<{ n: number }>("SELECT changes() AS n").one().n,
});

const toStatement = <T, P extends SqlValue[]>(
	sql: SqlStorage,
	statement: string,
): DbStatement<T, P> => ({
	get: (...params: P) => {
		const rows = sql.exec<T & Record<string, SqlStorageValue>>(
			statement,
			...bind(params),
		);
		return rows.toArray()[0] ?? null;
	},
	all: (...params: P) =>
		sql
			.exec<T & Record<string, SqlStorageValue>>(statement, ...bind(params))
			.toArray(),
	run: (...params: P) => {
		sql.exec(statement, ...bind(params));
		return changesOf(sql);
	},
});

/** Adapt a Durable Object's storage to the port. */
export const adapt = (storage: DurableObjectStorage): Db => {
	const sql = storage.sql;
	return {
		query: <T = Row, P extends SqlValue[] = SqlValue[]>(statement: string) =>
			toStatement<T, P>(sql, statement),
		prepare: <T = Row, P extends SqlValue[] = SqlValue[]>(statement: string) =>
			toStatement<T, P>(sql, statement),
		run: (statement, params) => {
			sql.exec(statement, ...bind(params ?? []));
			return changesOf(sql);
		},
		exec: (script) => {
			sql.exec(script);
		},
		transaction:
			<T>(fn: () => T) =>
			() =>
				storage.transactionSync(fn),
	};
};

export namespace DoDb {
	/**
	 * A provider bound to one object's storage. Construct it in the Durable
	 * Object constructor and hand it to `Runtime.configure`.
	 */
	export const provider = (storage: DurableObjectStorage): DbProvider => {
		const db = adapt(storage);
		return {
			withDb: async <T>(
				_basePath: string,
				fn: (db: Db) => T | Promise<T>,
			): Promise<Result<T>> => {
				try {
					return ok(await fn(db));
				} catch (e) {
					return err(toError(e));
				}
			},
			/**
			 * `storage.transaction` is the asynchronous transaction the KV API has
			 * always had; on a SQLite-backed object it spans `sql.exec` too, and a
			 * throw inside rolls every statement back. Verified by the conformance
			 * suite rather than assumed.
			 */
			atomic: async <T>(
				_basePath: string,
				fn: (db: Db) => T | Promise<T>,
			): Promise<Result<T>> => {
				try {
					return ok(await storage.transaction(() => Promise.resolve(fn(db))));
				} catch (e) {
					return err(toError(e));
				}
			},
		};
	};
}
