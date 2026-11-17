// Where a run's row lives: the extension's own replicated table (JCAB-444:1). It ships with the
// extension and is absent when it is disabled; a device without it, the hub included, parks its
// ops. Nothing outside this file knows the table, so moving the row elsewhere changes this file.
import { hostname } from "node:os";
import type { Db, Host, KabaneModule, Result } from "@cabane/extension";
import { err, ok, trySync } from "./result";
import type { Runtime } from "./runtime";

export namespace Runs {
	/**
	 * What a run is doing, as its program reported it to its runtime; kabane never decides that it
	 * succeeded. `live` is a program still there that has reported nothing.
	 */
	export type State = "live" | "running" | "waiting" | "idle" | "ended";
	const STATES = ["live", "running", "waiting", "idle", "ended"] as const;

	export type Run = {
		id: string;
		recipe: { name: string; hash: string };
		/** What the run works on, when the recipe has a target: `issue` or `job`. */
		target?: { kind: string; id: string };
		/** The scope's URI. */
		scope: string;
		/** The folder the run started in, relative to the scope root ("" at the root). */
		dir: string;
		machine: string;
		cwd: string;
		/** The runtime's name, such as `hc`. */
		runtime: string;
		/** The runtime's own handle for what it started, which only that runtime reads. */
		session: string;
		inputs: Record<string, unknown>;
		/** The command the run started, the prompt left out; absent on a run recorded before it was kept. */
		harness?: string[];
		state: State;
		startedAt: string;
		endedAt?: string;
	};

	const TABLE = "recipes_runs";

	/** What the store reads and writes with. */
	type Store = Pick<Host, "store" | "z">;

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
						   target_kind TEXT,
						   target_id TEXT,
						   scope_uri TEXT NOT NULL,
						   dir TEXT NOT NULL,
						   machine TEXT NOT NULL,
						   cwd TEXT NOT NULL,
						   runtime TEXT NOT NULL,
						   session TEXT NOT NULL,
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
			{
				name: "add-recipes-runs-harness",
				up: (db) => db.run(`ALTER TABLE ${TABLE} ADD COLUMN harness TEXT`),
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

	/** A stored row, which may have come from another device's ops: checked, never cast. */
	const rowSchema = (z: Host["z"]) =>
		z.object({
			id: z.string(),
			recipe: z.string(),
			recipe_hash: z.string(),
			target_kind: z.string().nullable(),
			target_id: z.string().nullable(),
			scope_uri: z.string(),
			dir: z.string(),
			machine: z.string(),
			cwd: z.string(),
			runtime: z.string(),
			session: z.string(),
			inputs: z.string(),
			harness: z.string().nullable(),
			state: z.enum(STATES),
			started_at: z.string(),
			ended_at: z.string().nullable(),
		});

	const fromRow = (z: Host["z"], raw: unknown): Result<Run> => {
		const row = rowSchema(z).safeParse(raw);
		if (!row.success)
			return err(
				new Error(`${TABLE}: a row kabane cannot read: ${row.error.message}`),
			);
		const { data } = row;
		if ((data.target_kind === null) !== (data.target_id === null))
			return err(
				new Error(
					`${TABLE}: run ${data.id} has a target_kind or a target_id without the other`,
				),
			);
		const json = trySync((): unknown => JSON.parse(data.inputs));
		const inputs = json.ok
			? z.record(z.unknown()).safeParse(json.value)
			: undefined;
		if (!inputs?.success)
			return err(
				new Error(
					`${TABLE}: run ${data.id} has inputs that are not a JSON object`,
				),
			);
		const command = trySync((): unknown =>
			data.harness === null ? null : JSON.parse(data.harness),
		);
		const harness = command.ok
			? z.array(z.string()).nullable().safeParse(command.value)
			: undefined;
		if (!harness?.success)
			return err(
				new Error(
					`${TABLE}: run ${data.id} has a harness that is not a list of words`,
				),
			);
		return ok({
			id: data.id,
			recipe: { name: data.recipe, hash: data.recipe_hash },
			...(data.target_kind === null || data.target_id === null
				? {}
				: { target: { kind: data.target_kind, id: data.target_id } }),
			scope: data.scope_uri,
			dir: data.dir,
			machine: data.machine,
			cwd: data.cwd,
			runtime: data.runtime,
			session: data.session,
			inputs: inputs.data,
			...(harness.data === null ? {} : { harness: harness.data }),
			state: data.state,
			startedAt: data.started_at,
			...(data.ended_at === null ? {} : { endedAt: data.ended_at }),
		});
	};

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
		host: Store,
		run: Run,
		actor: string,
	): Promise<Result<Run>> =>
		host.store.write((tx) => {
			tx.db.run(
				`INSERT INTO ${TABLE} (id, recipe, recipe_hash, target_kind, target_id, scope_uri, dir,
				   machine, cwd, runtime, session, inputs, harness, state, started_at, ended_at,
				   updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					run.id,
					run.recipe.name,
					run.recipe.hash,
					run.target?.kind ?? null,
					run.target?.id ?? null,
					run.scope,
					run.dir,
					run.machine,
					run.cwd,
					run.runtime,
					run.session,
					JSON.stringify(run.inputs),
					run.harness === undefined ? null : JSON.stringify(run.harness),
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

	/** The session of a run recorded before its runtime started it. */
	export const STARTING = "";

	/** The handle the runtime returned for a run recorded as `STARTING`. */
	export const setSession = (
		host: Store,
		id: string,
		session: string,
		actor: string,
	): Promise<Result<void>> =>
		host.store.write((tx) => {
			tx.db.run(
				`UPDATE ${TABLE} SET session = ?, updated_at = ?, updated_by = ?,
				   version = version + 1 WHERE id = ?`,
				[session, new Date().toISOString(), actor, id],
			);
			return tx.afterWrite(TABLE, "update", id);
		});

	/** A run's new state; `ended` also stamps when it ended. */
	export const setState = (
		host: Store,
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

	/**
	 * Each unfinished run of this machine, with the state its runtime reports now. A run whose
	 * start has not recorded its session yet stays as recorded: one whose start was interrupted
	 * stays `live` with no terminal.
	 */
	export const reconcile = async (
		host: Store,
		runtime: Runtime,
		runs: Run[],
		actor: string,
	): Promise<Result<Run[]>> => {
		const here = hostname();
		const current: Run[] = [];
		for (const run of runs) {
			if (
				run.machine !== here ||
				run.state === "ended" ||
				run.runtime !== runtime.name ||
				run.session === STARTING
			) {
				current.push(run);
				continue;
			}
			const seen = await runtime.get(run.session);
			if (!seen.ok) return seen;
			if (seen.value === run.state) {
				current.push(run);
				continue;
			}
			const written = await setState(host, run.id, seen.value, actor);
			if (!written.ok) return written;
			current.push({
				...run,
				state: seen.value,
				...(seen.value === "ended"
					? { endedAt: new Date().toISOString() }
					: {}),
			});
		}
		return ok(current);
	};

	/** Stops the run's session in its runtime; resolves to the state the runtime reports after. */
	export const stop = async (
		host: Store,
		runtime: Runtime,
		run: Run,
		actor: string,
	): Promise<Result<State>> => {
		const stopped = await runtime.stop(run.session);
		if (!stopped.ok) return stopped;
		const now = await reconcile(host, runtime, [run], actor);
		return now.ok ? ok(now.value[0]?.state ?? run.state) : now;
	};

	const select = (
		z: Host["z"],
		db: Db,
		where: string,
		params: string[],
	): Result<Run[]> => {
		const rows = db
			.query(
				`SELECT * FROM ${TABLE} WHERE ${where} ORDER BY started_at DESC, id DESC`,
			)
			.all(...params);
		const runs: Run[] = [];
		for (const row of rows) {
			const run = fromRow(z, row);
			if (!run.ok) return run;
			runs.push(run.value);
		}
		return ok(runs);
	};

	/** Only `scope`'s runs, or with none, every scope's. */
	const inScope = (
		scope: string | undefined,
		where: string,
		params: string[],
	): [string, string[]] =>
		scope === undefined
			? [where, params]
			: [`scope_uri = ? AND (${where})`, [scope, ...params]];

	/** The runs of `scope`, or of every scope with none, newest first. */
	export const list = (
		host: Store,
		scope: string | undefined,
	): Promise<Result<Run[]>> =>
		host.store.read((db) => select(host.z, db, ...inScope(scope, "1 = 1", [])));

	/**
	 * The runs whose id is `key` or ends with it, case aside, in `scope`, or in every scope with
	 * none.
	 */
	export const find = (
		host: Store,
		scope: string | undefined,
		key: string,
	): Promise<Result<Run[]>> =>
		host.store.read((db) =>
			select(
				host.z,
				db,
				...inScope(scope, "id = ? OR id LIKE ?", [
					key.toUpperCase(),
					`%${key.toUpperCase().replace(/[%_]/g, "")}`,
				]),
			),
		);
}
