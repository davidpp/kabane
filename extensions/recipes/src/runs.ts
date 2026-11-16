// Where a run's row lives: the extension's own replicated table (JCAB-444:1). It ships with the
// extension and is absent when it is disabled; a device without it, the hub included, parks its
// ops. Nothing outside this file knows the table, so moving the row elsewhere changes this file.
import type { Db, Host, KabaneModule, Result } from "@cabane/extension";
import { ok } from "./result";

export namespace Runs {
	/** What a run is doing, read from its runtime; kabane never decides that it succeeded. */
	export type State = "running" | "waiting" | "idle" | "ended";

	export type Run = {
		id: string;
		recipe: { name: string; hash: string };
		/** The target issue's id, when the recipe has one. */
		target?: string;
		/** The scope's URI. */
		scope: string;
		/** The folder the run started in, relative to the scope root ("" at the root). */
		dir: string;
		machine: string;
		cwd: string;
		runtime: "hc";
		/** The runtime's name for the terminal. */
		terminal: string;
		inputs: Record<string, unknown>;
		state: State;
		startedAt: string;
		endedAt?: string;
	};

	const TABLE = "recipes_runs";

	export const module = (): KabaneModule => ({
		name: "recipes",
		migrations: [
			{
				name: "create-recipes-runs",
				up: (db) =>
					db.run(
						`CREATE TABLE IF NOT EXISTS ${TABLE} (
						   id TEXT PRIMARY KEY,
						   recipe TEXT NOT NULL,
						   recipe_hash TEXT NOT NULL,
						   target_id TEXT,
						   scope_uri TEXT NOT NULL,
						   dir TEXT NOT NULL,
						   machine TEXT NOT NULL,
						   cwd TEXT NOT NULL,
						   runtime TEXT NOT NULL,
						   terminal TEXT NOT NULL,
						   inputs TEXT NOT NULL,
						   state TEXT NOT NULL,
						   started_at TEXT NOT NULL,
						   ended_at TEXT,
						   updated_at TEXT NOT NULL,
						   updated_by TEXT,
						   version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared'
						 )`,
					),
			},
		],
		// A run names its issue without owning it: deleting the issue keeps its runs.
		syncTables: [
			{
				table: TABLE,
				family: "row-lww",
				clock: "updated_at",
				childOfTasks: false,
			},
		],
	});

	type Row = {
		id: string;
		recipe: string;
		recipe_hash: string;
		target_id: string | null;
		scope_uri: string;
		dir: string;
		machine: string;
		cwd: string;
		runtime: string;
		terminal: string;
		inputs: string;
		state: string;
		started_at: string;
		ended_at: string | null;
	};

	const fromRow = (row: Row): Run => ({
		id: row.id,
		recipe: { name: row.recipe, hash: row.recipe_hash },
		...(row.target_id === null ? {} : { target: row.target_id }),
		scope: row.scope_uri,
		dir: row.dir,
		machine: row.machine,
		cwd: row.cwd,
		runtime: "hc",
		terminal: row.terminal,
		inputs: JSON.parse(row.inputs) as Record<string, unknown>,
		state: row.state as State,
		startedAt: row.started_at,
		...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
	});

	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

	/** A ULID: 48 bits of milliseconds, then 80 random bits, in Crockford base32. */
	export const newId = (now = Date.now()): string => {
		let time = "";
		for (let left = now, i = 0; i < 10; i++, left = Math.floor(left / 32))
			time = CROCKFORD[left % 32] + time;
		const random = crypto.getRandomValues(new Uint8Array(16));
		let tail = "";
		for (const byte of random) tail += CROCKFORD[byte % 32];
		return time + tail;
	};

	export const insert = (
		host: Host,
		run: Run,
		actor: string,
	): Promise<Result<Run>> =>
		host.store.write((tx) => {
			tx.db.run(
				`INSERT INTO ${TABLE} (id, recipe, recipe_hash, target_id, scope_uri, dir, machine, cwd,
				   runtime, terminal, inputs, state, started_at, ended_at, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					run.id,
					run.recipe.name,
					run.recipe.hash,
					run.target ?? null,
					run.scope,
					run.dir,
					run.machine,
					run.cwd,
					run.runtime,
					run.terminal,
					JSON.stringify(run.inputs),
					run.state,
					run.startedAt,
					run.endedAt ?? null,
					new Date().toISOString(),
					actor,
				],
			);
			const captured = tx.afterWrite(TABLE, "insert", run.id);
			return captured.ok ? ok(run) : captured;
		});

	/** A run's new state; `ended` also stamps when it ended. */
	export const setState = (
		host: Host,
		id: string,
		state: State,
		actor: string,
	): Promise<Result<void>> =>
		host.store.write((tx) => {
			const now = new Date().toISOString();
			tx.db.run(
				`UPDATE ${TABLE} SET state = ?, ended_at = ?, updated_at = ?, updated_by = ?,
				   version = version + 1 WHERE id = ?`,
				[state, state === "ended" ? now : null, now, actor, id],
			);
			return tx.afterWrite(TABLE, "update", id);
		});

	const select = (db: Db, where: string, params: string[]): Run[] =>
		(
			db
				.query(
					`SELECT * FROM ${TABLE} WHERE ${where} ORDER BY started_at DESC, id DESC`,
				)
				.all(...params) as Row[]
		).map(fromRow);

	/** The scope's runs, newest first. */
	export const list = (host: Host, scope: string): Promise<Result<Run[]>> =>
		host.store.read((db) => ok(select(db, "scope_uri = ?", [scope])));

	/** The scope's runs whose id is `key` or ends with it, case aside. */
	export const find = (
		host: Host,
		scope: string,
		key: string,
	): Promise<Result<Run[]>> =>
		host.store.read((db) =>
			ok(
				select(db, "scope_uri = ? AND (id = ? OR id LIKE ?)", [
					scope,
					key.toUpperCase(),
					`%${key.toUpperCase().replace(/[%_]/g, "")}`,
				]),
			),
		);
}
