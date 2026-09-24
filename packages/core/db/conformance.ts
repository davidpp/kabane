/**
 * Db port conformance.
 *
 * Every adapter runs the same cases so the two engines cannot drift apart on
 * the details storage relies on: exact `changes`, transaction rollback on a
 * throw, `atomic` surviving an await, parameter binding, multi-statement
 * `exec`, FTS5 and `json_each` being present, the core schema applying, and
 * the migration runner committing, rolling back and refusing a newer database.
 *
 * Framework-free on purpose. `bun:test` and vitest cannot both be imported
 * here, so each case is a plain async function that throws on failure and the
 * adapter's own test file wraps them in its runner:
 *
 * ```ts
 * for (const c of conformanceCases()) it(c.name, () => c.run(provider))
 * ```
 */

import { Migrate } from "./migrate";
import type { Db, DbProvider, Row } from "./port";
import { applySchema } from "./schema";
import { setTablePrefix, TABLES } from "./tables";

export type ConformanceCase = {
	name: string;
	run: (provider: DbProvider) => Promise<void>;
};

const assert = (condition: boolean, message: string): void => {
	if (!condition) throw new Error(`conformance: ${message}`);
};

const assertEqual = (
	actual: unknown,
	expected: unknown,
	what: string,
): void => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	assert(a === e, `${what}: expected ${e}, got ${a}`);
};

/** Unwrap a provider result or fail the case with its error. */
const must = async <T>(
	p: Promise<{ ok: true; value: T } | { ok: false; error: Error }>,
): Promise<T> => {
	const r = await p;
	if (!r.ok)
		throw new Error(`conformance: provider returned err: ${r.error.message}`);
	return r.value;
};

/** A scratch table name unique per case so shared storage between tests is harmless. */
const scratch = (label: string): string =>
	`conf_${label}_${Math.random().toString(36).slice(2, 8)}`;

const BASE = "conformance";

/** Unwrap a runner result inside a case, or fail the case with its error. */
const migrated = (result: ReturnType<typeof Migrate.run>): Migrate.Report => {
	if (!result.ok) throw new Error(`conformance: ${result.error.message}`);
	return result.value;
};

const rowCount = (db: Db, table: string): number =>
	db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;

export const conformanceCases = (): ConformanceCase[] => [
	{
		name: "binds parameters of every SqlValue type and reads them back",
		run: async (provider) => {
			const t = scratch("bind");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(
						`CREATE TABLE ${t} (s TEXT, n REAL, i INTEGER, b INTEGER, z TEXT, blob BLOB)`,
					);
					db.run(`INSERT INTO ${t} VALUES (?, ?, ?, ?, ?, ?)`, [
						"text",
						1.5,
						42n,
						true,
						null,
						new Uint8Array([1, 2, 3]),
					]);
					const row = db.query<Row>(`SELECT * FROM ${t}`).get();
					assert(row !== null, "row should exist");
					assertEqual(row?.s, "text", "text");
					assertEqual(row?.n, 1.5, "real");
					assertEqual(Number(row?.i), 42, "bigint as integer");
					assertEqual(Number(row?.b), 1, "boolean as 1");
					assertEqual(row?.z, null, "null");
					const blob = row?.blob;
					const bytes =
						blob instanceof Uint8Array
							? Array.from(blob)
							: blob instanceof ArrayBuffer
								? Array.from(new Uint8Array(blob))
								: null;
					assertEqual(bytes, [1, 2, 3], "blob bytes");
				}),
			);
		},
	},
	{
		name: "get returns null for no row and all returns every row in order",
		run: async (provider) => {
			const t = scratch("rows");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v TEXT)`);
					assertEqual(db.query(`SELECT * FROM ${t}`).get(), null, "empty get");
					const insert = db.query<Row, [string]>(
						`INSERT INTO ${t} (v) VALUES (?)`,
					);
					insert.run("a");
					insert.run("b");
					insert.run("c");
					assertEqual(
						db
							.query<{ v: string }>(`SELECT v FROM ${t} ORDER BY id`)
							.all()
							.map((r) => r.v),
						["a", "b", "c"],
						"all in order",
					);
					assertEqual(
						db
							.query<{ v: string }, [number]>(`SELECT v FROM ${t} WHERE id = ?`)
							.get(2)?.v,
						"b",
						"get by param",
					);
				}),
			);
		},
	},
	{
		name: "changes is exact: matched rows, not index writes, zero on no match",
		run: async (provider) => {
			const t = scratch("changes");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(
						`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v TEXT, w TEXT); CREATE INDEX ${t}_v ON ${t}(v); CREATE INDEX ${t}_w ON ${t}(w)`,
					);
					assertEqual(
						db.run(`INSERT INTO ${t} (v, w) VALUES ('x', 'y')`).changes,
						1,
						"insert",
					);
					db.run(`INSERT INTO ${t} (v, w) VALUES ('x', 'y')`);
					assertEqual(
						db.run(`UPDATE ${t} SET v = 'z'`).changes,
						2,
						"update two rows",
					);
					assertEqual(
						db.run(`UPDATE ${t} SET v = 'q' WHERE id = 99`).changes,
						0,
						"no match",
					);
					assertEqual(
						db.run(`INSERT OR IGNORE INTO ${t} (id, v) VALUES (1, 'dup')`)
							.changes,
						0,
						"ignored insert",
					);
					assertEqual(
						db.query(`DELETE FROM ${t}`).run().changes,
						2,
						"statement run delete",
					);
				}),
			);
		},
	},
	{
		name: "exec runs a multi-statement script",
		run: async (provider) => {
			const t = scratch("script");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(`
						CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v TEXT);
						INSERT INTO ${t} (v) VALUES ('one');
						INSERT INTO ${t} (v) VALUES ('two');
						CREATE INDEX IF NOT EXISTS ${t}_v ON ${t}(v);
					`);
					assertEqual(
						db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n,
						2,
						"rows from script",
					);
				}),
			);
		},
	},
	{
		name: "transaction commits on return and rolls back on throw",
		run: async (provider) => {
			const t = scratch("txn");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(`CREATE TABLE ${t} (v TEXT)`);
					db.transaction(() => {
						db.run(`INSERT INTO ${t} VALUES ('kept')`);
					})();
					let threw = false;
					try {
						db.transaction(() => {
							db.run(`INSERT INTO ${t} VALUES ('lost')`);
							throw new Error("boom");
						})();
					} catch {
						threw = true;
					}
					assert(threw, "throw propagates out of transaction");
					assertEqual(
						db
							.query<{ v: string }>(`SELECT v FROM ${t}`)
							.all()
							.map((r) => r.v),
						["kept"],
						"only the committed row remains",
					);
				}),
			);
		},
	},
	{
		name: "withDb turns a thrown error into err and stays usable",
		run: async (provider) => {
			const failed = await provider.withDb(BASE, () => {
				throw new Error("expected failure");
			});
			assert(!failed.ok, "should be err");
			if (!failed.ok)
				assertEqual(failed.error.message, "expected failure", "error message");
			await must(
				provider.withDb(BASE, (db) => db.query("SELECT 1 AS one").get()),
			);
		},
	},
	{
		name: "atomic commits an awaiting body and rolls it back on a late throw",
		run: async (provider) => {
			const t = scratch("atomic");
			await must(
				provider.withDb(BASE, (db) => db.exec(`CREATE TABLE ${t} (v TEXT)`)),
			);
			const atomic = provider.atomic
				? provider.atomic.bind(provider)
				: async <T>(base: string, fn: (db: Db) => T | Promise<T>) =>
						provider.withDb(base, async (db) => {
							db.run("BEGIN IMMEDIATE");
							try {
								const value = await fn(db);
								db.run("COMMIT");
								return value;
							} catch (e) {
								db.run("ROLLBACK");
								throw e;
							}
						});
			await must(
				atomic(BASE, async (db) => {
					db.run(`INSERT INTO ${t} VALUES ('first')`);
					await Promise.resolve();
					db.run(`INSERT INTO ${t} VALUES ('second')`);
				}),
			);
			const rolled = await atomic(BASE, async (db) => {
				db.run(`INSERT INTO ${t} VALUES ('third')`);
				await Promise.resolve();
				throw new Error("late");
			});
			assert(!rolled.ok, "late throw becomes err");
			await must(
				provider.withDb(BASE, (db) => {
					assertEqual(
						db
							.query<{ v: string }>(`SELECT v FROM ${t} ORDER BY v`)
							.all()
							.map((r) => r.v),
						["first", "second"],
						"third rolled back",
					);
				}),
			);
		},
	},
	{
		name: "json_each unpacks one parameter into many rows past the 100-binding cap",
		run: async (provider) => {
			const t = scratch("json");
			const values = Array.from({ length: 300 }, (_, i) => ({ k: `k${i}`, i }));
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(`CREATE TABLE ${t} (k TEXT PRIMARY KEY, i INTEGER)`);
					const inserted = db.run(
						`INSERT INTO ${t} (k, i) SELECT json_extract(value, '$.k'), json_extract(value, '$.i') FROM json_each(?)`,
						[JSON.stringify(values)],
					);
					assertEqual(
						inserted.changes,
						300,
						"rows inserted from one parameter",
					);
					assertEqual(
						db.query<{ s: number }>(`SELECT SUM(i) AS s FROM ${t}`).get()?.s,
						(299 * 300) / 2,
						"sum of unpacked integers",
					);
				}),
			);
		},
	},
	{
		name: "FTS5 is available and matches",
		run: async (provider) => {
			const t = scratch("fts");
			await must(
				provider.withDb(BASE, (db) => {
					db.exec(`CREATE VIRTUAL TABLE ${t} USING fts5(title)`);
					db.run(`INSERT INTO ${t}(title) VALUES ('fix the login bug')`);
					db.run(`INSERT INTO ${t}(title) VALUES ('write release notes')`);
					assertEqual(
						db
							.query<{ title: string }, [string]>(
								`SELECT title FROM ${t} WHERE ${t} MATCH ?`,
							)
							.all("login")
							.map((r) => r.title),
						["fix the login bug"],
						"fts match",
					);
				}),
			);
		},
	},
	{
		name: "applies the core schema with plain names, idempotently",
		run: async (provider) => {
			setTablePrefix("");
			await must(
				provider.withDb(BASE, (db) => {
					applySchema(db);
					applySchema(db);
					const names = db
						.query<{ name: string }>(
							"SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name",
						)
						.all()
						.map((r) => r.name);
					for (const required of [
						TABLES.tasks,
						TABLES.tasks_fts,
						TABLES.agent_sessions,
						TABLES.sync_oplog,
					]) {
						assert(names.includes(required), `schema creates ${required}`);
					}
					assert(
						names.includes(`${TABLES.tasks_fts}_ai`),
						"FTS insert trigger exists (CREATE TRIGGER works on this engine)",
					);
				}),
			);
		},
	},
	{
		name: "migrations run once each, in order, and a second run applies nothing",
		run: async (provider) => {
			const versions = scratch("mig_versions");
			const data = scratch("mig_data");
			const list: Migrate.Migration[] = [
				{
					name: "create",
					up: (db) => db.exec(`CREATE TABLE ${data} (n INTEGER)`),
				},
				{
					name: "seed",
					up: (db) => {
						db.run(`INSERT INTO ${data} (n) VALUES (1)`);
					},
				},
			];
			await must(
				provider.withDb(BASE, (db) => {
					const first = migrated(Migrate.run(db, list, versions));
					assertEqual(
						first,
						{ from: 0, to: 2, applied: ["create", "seed"] },
						"first run",
					);
					const second = migrated(Migrate.run(db, list, versions));
					assertEqual(second, { from: 2, to: 2, applied: [] }, "second run");
					assertEqual(rowCount(db, data), 1, "seed ran once");
					assertEqual(
						db
							.query<{ version: number; name: string }>(
								`SELECT version, name FROM ${versions} ORDER BY version`,
							)
							.all(),
						[
							{ version: 1, name: "create" },
							{ version: 2, name: "seed" },
						],
						"version rows",
					);
				}),
			);
		},
	},
	{
		name: "a migration that throws rolls back with its version row, and the next run retries it",
		run: async (provider) => {
			const versions = scratch("mig_versions");
			const data = scratch("mig_data");
			const create: Migrate.Migration = {
				name: "create",
				up: (db) => db.exec(`CREATE TABLE ${data} (n INTEGER)`),
			};
			const failing: Migrate.Migration = {
				name: "half",
				up: (db) => {
					db.run(`INSERT INTO ${data} (n) VALUES (1)`);
					throw new Error("boom");
				},
			};
			const fixed: Migrate.Migration = {
				name: "half",
				up: (db) => {
					db.run(`INSERT INTO ${data} (n) VALUES (2)`);
				},
			};
			await must(
				provider.withDb(BASE, (db) => {
					const failed = Migrate.run(db, [create, failing], versions);
					assert(!failed.ok, "a throwing migration is an err");
					assert(
						!failed.ok &&
							failed.error.message.includes("schema migration 2 (half)") &&
							failed.error.message.includes("still at version 1") &&
							failed.error.message.includes("boom"),
						`the error names the migration and the version left: ${failed.ok ? "" : failed.error.message}`,
					);
					assertEqual(
						rowCount(db, data),
						0,
						"the failed migration's insert rolled back",
					);
					assertEqual(Migrate.current(db, versions), 1, "version stays at 1");
					const retried = migrated(Migrate.run(db, [create, fixed], versions));
					assertEqual(retried.applied, ["half"], "the next run retries it");
					assertEqual(rowCount(db, data), 1, "and it lands once");
				}),
			);
		},
	},
	{
		name: "a database already past the list is refused, untouched",
		run: async (provider) => {
			const versions = scratch("mig_versions");
			await must(
				provider.withDb(BASE, (db) => {
					migrated(
						Migrate.run(
							db,
							[
								{ name: "a", up: () => {} },
								{ name: "b", up: () => {} },
							],
							versions,
						),
					);
					const older = Migrate.run(
						db,
						[{ name: "a", up: () => {} }],
						versions,
					);
					assert(
						!older.ok && older.error.message.includes("update kabane"),
						"an older list refuses a newer database and says to update",
					);
					assertEqual(Migrate.current(db, versions), 2, "version unchanged");
				}),
			);
		},
	},
	{
		name: "the core schema applies inside a migration's transaction",
		run: async (provider) => {
			setTablePrefix("");
			const versions = scratch("mig_versions");
			await must(
				provider.withDb(BASE, (db) => {
					const report = migrated(
						Migrate.run(db, [{ name: "baseline", up: applySchema }], versions),
					);
					assertEqual(report.applied, ["baseline"], "applied");
					assert(
						db
							.query<{ name: string }>(
								"SELECT name FROM sqlite_master WHERE name = ?",
							)
							.get(`${TABLES.tasks_fts}_ai`) !== null,
						"FTS triggers exist after a transactional apply",
					);
				}),
			);
		},
	},
];
