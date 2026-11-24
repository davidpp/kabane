// Where a job's schedule lives: one row per item of kind `job`, in the extension's own replicated
// table, and this machine's folder for each scope, which never leaves it. Nothing outside this file
// knows either table.
import type { Host, KabaneModule, Result } from "@kabane/extension";
import { actorScheme } from "./actor-scheme";
import { err, ok, trySync } from "./result";
import type { Runs } from "./runs";

export namespace Jobs {
	/**
	 * What a fire does with the job's terminal: `fresh` starts a new one each time; `keep` types
	 * the prompt into the last one while it is idle, so the harness keeps its conversation.
	 */
	export type Session = "fresh" | "keep";
	export const SESSIONS = ["fresh", "keep"] as const;

	export type Job = {
		/** The job item's id. */
		taskId: string;
		/** A cron expression, read in this machine's time zone. */
		schedule: string;
		/** The recipe it runs; absent, its prompt is the job's request (its item's description). */
		recipe?: string;
		inputs: Record<string, unknown>;
		/** The command this job starts instead of `jobs.harness`. */
		harness?: string[];
		session: Session;
		/** A shell command a due fire runs first: the run starts only when it exits 0. */
		check?: string;
		lastFiredAt?: string;
		createdAt: string;
	};

	const TABLE = "jobs_jobs";
	const ROOTS = "jobs_roots";
	const SEEN = "jobs_attention";

	type Store = Pick<Host, "store" | "z">;

	/** The `recipe` column of a job with none: the column is NOT NULL, and "" names no recipe file. */
	const NO_RECIPE = "";

	export const module = (): KabaneModule => ({
		name: "jobs",
		migrations: [
			{
				name: "create-jobs-jobs",
				up: (db) => {
					db.run(
						`CREATE TABLE IF NOT EXISTS ${TABLE} (
						   id TEXT PRIMARY KEY,
						   task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
						   schedule TEXT NOT NULL,
						   recipe TEXT NOT NULL,
						   inputs TEXT NOT NULL,
						   harness TEXT,
						   last_fired_at TEXT,
						   created_at TEXT NOT NULL,
						   updated_at TEXT NOT NULL,
						   updated_by TEXT,
						   version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared'
						 )`,
					);
					// Machine-local: a folder is a path on this machine, so this table is not synced.
					db.run(
						`CREATE TABLE IF NOT EXISTS ${ROOTS} (
						   scope_uri TEXT PRIMARY KEY,
						   root TEXT NOT NULL,
						   updated_at TEXT NOT NULL
						 )`,
					);
				},
			},
			{
				name: "add-jobs-jobs-session",
				up: (db) =>
					db.run(
						`ALTER TABLE ${TABLE} ADD COLUMN session TEXT NOT NULL DEFAULT 'fresh'`,
					),
			},
			{
				name: "create-jobs-attention",
				// Machine-local, like the folders: the state this machine's tick last saw each run
				// in, so the attention hook runs once per change. Not in syncTables.
				up: (db) =>
					db.run(
						`CREATE TABLE IF NOT EXISTS ${SEEN} (
						   run_id TEXT PRIMARY KEY,
						   state TEXT NOT NULL,
						   updated_at TEXT NOT NULL
						 )`,
					),
			},
			{
				name: "add-jobs-jobs-check",
				up: (db) => db.run(`ALTER TABLE ${TABLE} ADD COLUMN "check" TEXT`),
			},
			actorScheme(TABLE),
			{
				// kabane's core migration 14 moved tasks into the record and made `tasks` a
				// view (JCAB-660). A job's item is a thread now, which no foreign key can
				// name: the table is rebuilt without one, every row kept.
				name: "detach-from-tasks",
				up: (db) => {
					db.run(
						`CREATE TABLE ${TABLE}_new (
						   id TEXT PRIMARY KEY,
						   task_id TEXT NOT NULL,
						   schedule TEXT NOT NULL,
						   recipe TEXT NOT NULL,
						   inputs TEXT NOT NULL,
						   harness TEXT,
						   last_fired_at TEXT,
						   created_at TEXT NOT NULL,
						   updated_at TEXT NOT NULL,
						   updated_by TEXT,
						   version INTEGER NOT NULL DEFAULT 1,
						   visibility TEXT NOT NULL DEFAULT 'shared',
						   session TEXT NOT NULL DEFAULT 'fresh',
						   "check" TEXT
						 )`,
					);
					db.run(
						`INSERT INTO ${TABLE}_new
						   (id, task_id, schedule, recipe, inputs, harness, last_fired_at, created_at,
						    updated_at, updated_by, version, visibility, session, "check")
						 SELECT id, task_id, schedule, recipe, inputs, harness, last_fired_at, created_at,
						        updated_at, updated_by, version, visibility, session, "check"
						   FROM ${TABLE}`,
					);
					db.run(`DROP TABLE ${TABLE}`);
					db.run(`ALTER TABLE ${TABLE}_new RENAME TO ${TABLE}`);
				},
			},
		],
		syncTables: [
			{
				table: TABLE,
				family: "row-lww",
				clock: "updated_at",
				childOfTasks: true,
			},
		],
	});

	/** A stored row, which may have come from another device's ops: checked, never cast. */
	const fromRow = (z: Host["z"], raw: unknown): Result<Job> => {
		const row = z
			.object({
				task_id: z.string(),
				schedule: z.string(),
				recipe: z.string(),
				inputs: z.string(),
				harness: z.string().nullable(),
				session: z.enum(SESSIONS),
				check: z.string().nullable(),
				last_fired_at: z.string().nullable(),
				created_at: z.string(),
			})
			.safeParse(raw);
		if (!row.success)
			return err(
				new Error(`${TABLE}: a row kabane cannot read: ${row.error.message}`),
			);
		const { data } = row;
		const inputs = trySync((): unknown => JSON.parse(data.inputs));
		const harness = trySync((): unknown =>
			data.harness === null ? null : JSON.parse(data.harness),
		);
		const parsedInputs = inputs.ok
			? z.record(z.string(), z.unknown()).safeParse(inputs.value)
			: undefined;
		const parsedHarness = harness.ok
			? z.array(z.string()).nullable().safeParse(harness.value)
			: undefined;
		if (!parsedInputs?.success || !parsedHarness?.success)
			return err(
				new Error(
					`${TABLE}: job ${data.task_id} has inputs or a harness kabane cannot read`,
				),
			);
		return ok({
			taskId: data.task_id,
			schedule: data.schedule,
			...(data.recipe === NO_RECIPE ? {} : { recipe: data.recipe }),
			inputs: parsedInputs.data,
			...(parsedHarness.data === null ? {} : { harness: parsedHarness.data }),
			session: data.session,
			...(data.check === null ? {} : { check: data.check }),
			...(data.last_fired_at === null
				? {}
				: { lastFiredAt: data.last_fired_at }),
			createdAt: data.created_at,
		});
	};

	export const insert = (
		host: Store,
		job: Job,
		actor: string,
	): Promise<Result<Job>> =>
		host.store.write((tx) => {
			tx.db.run(
				`INSERT INTO ${TABLE} (id, task_id, schedule, recipe, inputs, harness, session,
				   "check", last_fired_at, created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					job.taskId,
					job.taskId,
					job.schedule,
					job.recipe ?? NO_RECIPE,
					JSON.stringify(job.inputs),
					job.harness === undefined ? null : JSON.stringify(job.harness),
					job.session,
					job.check ?? null,
					job.lastFiredAt ?? null,
					job.createdAt,
					new Date().toISOString(),
					actor,
				],
			);
			const captured = tx.afterWrite(TABLE, "insert", job.taskId);
			return captured.ok ? ok(job) : captured;
		});

	/** What `job edit` changes on the row; `null` clears the job's own harness or its check. */
	export type Change = {
		schedule?: string;
		inputs?: Record<string, unknown>;
		harness?: string[] | null;
		session?: Session;
		check?: string | null;
	};

	/** The job with `change` applied: only the fields it names move. */
	export const edit = (job: Job, change: Change): Job => {
		const { harness: _harness, check: _check, ...kept } = job;
		const harness = change.harness === undefined ? job.harness : change.harness;
		const check = change.check === undefined ? job.check : change.check;
		return {
			...kept,
			schedule: change.schedule ?? job.schedule,
			inputs: change.inputs ?? job.inputs,
			session: change.session ?? job.session,
			...(harness === null || harness === undefined ? {} : { harness }),
			...(check === null || check === undefined ? {} : { check }),
		};
	};

	/** Writes the row's schedule, inputs, harness, session and check as `job` has them. */
	export const update = (
		host: Store,
		job: Job,
		actor: string,
	): Promise<Result<Job>> =>
		host.store.write((tx) => {
			tx.db.run(
				`UPDATE ${TABLE} SET schedule = ?, inputs = ?, harness = ?, session = ?,
				   "check" = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
				[
					job.schedule,
					JSON.stringify(job.inputs),
					job.harness === undefined ? null : JSON.stringify(job.harness),
					job.session,
					job.check ?? null,
					new Date().toISOString(),
					actor,
					job.taskId,
				],
			);
			const captured = tx.afterWrite(TABLE, "update", job.taskId);
			return captured.ok ? ok(job) : captured;
		});

	export const setFired = (
		host: Store,
		taskId: string,
		at: string,
		actor: string,
	): Promise<Result<void>> =>
		host.store.write((tx) => {
			tx.db.run(
				`UPDATE ${TABLE} SET last_fired_at = ?, updated_at = ?, updated_by = ?,
				   version = version + 1 WHERE id = ?`,
				[at, new Date().toISOString(), actor, taskId],
			);
			return tx.afterWrite(TABLE, "update", taskId);
		});

	/** Every job row, oldest first. */
	export const all = (host: Store): Promise<Result<Job[]>> =>
		host.store.read((db) => {
			const jobs: Job[] = [];
			for (const row of db
				.query(`SELECT * FROM ${TABLE} ORDER BY created_at, id`)
				.all()) {
				const job = fromRow(host.z, row);
				if (!job.ok) return job;
				jobs.push(job.value);
			}
			return ok(jobs);
		});

	/** Records the folder of `scope` on this machine, which `tick` starts its jobs in. */
	export const setRoot = (
		host: Store,
		scope: string,
		root: string,
	): Promise<Result<void>> =>
		host.store.write((tx) => {
			tx.db.run(
				`INSERT INTO ${ROOTS} (scope_uri, root, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(scope_uri) DO UPDATE SET root = excluded.root,
				   updated_at = excluded.updated_at`,
				[scope, root, new Date().toISOString()],
			);
			return ok(undefined);
		});

	/** This machine's folder for each scope a `kabane job` command ran in. */
	export const roots = (host: Store): Promise<Result<Map<string, string>>> =>
		host.store.read((db) => {
			const { z } = host;
			const rows = z
				.array(z.object({ scope_uri: z.string(), root: z.string() }))
				.safeParse(db.query(`SELECT scope_uri, root FROM ${ROOTS}`).all());
			if (!rows.success)
				return err(new Error(`${ROOTS}: ${rows.error.message}`));
			return ok(new Map(rows.data.map((r) => [r.scope_uri, r.root])));
		});

	/** The schedule's next time after `since`, or why it has none. */
	export const nextAfter = (schedule: string, since: Date): Result<Date> => {
		const next = trySync(() => Bun.cron.parse(schedule, since));
		if (!next.ok)
			return err(new Error(`schedule "${schedule}": ${next.error.message}`));
		return next.value === null
			? err(new Error(`schedule "${schedule}" never fires`))
			: ok(next.value);
	};

	/** When the job fires next: its schedule's first time after its last fire, or its creation. */
	export const next = (job: Job): Result<Date> =>
		nextAfter(job.schedule, new Date(job.lastFiredAt ?? job.createdAt));

	/** Whether the job is due at `now`. Fires missed since the last one fold into this one. */
	export const due = (job: Job, now: Date): Result<boolean> => {
		const at = next(job);
		return at.ok ? ok(at.value.getTime() <= now.getTime()) : at;
	};

	/**
	 * What a fire does, given this machine's runs of the job (newest first) as their runtime
	 * reports them: skip while one is in flight. Otherwise a `fresh` job stops the idle ones (a
	 * harness stays at its prompt after its turn) and starts a new one; a `keep` job wakes the
	 * newest idle one with the prompt, and starts one only when none is left.
	 */
	type Fire =
		| { kind: "skip"; run: Runs.Run }
		| { kind: "wake"; run: Runs.Run }
		| { kind: "start"; stop: Runs.Run[] };

	export const decide = (session: Session, runs: readonly Runs.Run[]): Fire => {
		const busy = runs.find((run) =>
			(["live", "running", "waiting"] as Runs.State[]).includes(run.state),
		);
		if (busy) return { kind: "skip", run: busy };
		const idle = runs.filter((run) => run.state === "idle");
		if (session === "fresh") return { kind: "start", stop: idle };
		const [newest] = idle;
		return newest ? { kind: "wake", run: newest } : { kind: "start", stop: [] };
	};

	/** What a run's state asks of the human: `waiting` on them, or `finished` (`idle` or `ended`). */
	export type Attention = "waiting" | "finished";

	const attentionOf = (state: Runs.State | undefined): Attention | undefined =>
		state === "waiting"
			? "waiting"
			: state === "idle" || state === "ended"
				? "finished"
				: undefined;

	/**
	 * Whether a run seen in `state`, after it was last seen in `seen`, has just entered something
	 * the human hears about. `idle` then `ended` is one finish; `waiting`, `running`, `waiting` is two.
	 */
	export const attention = (
		seen: Runs.State | undefined,
		state: Runs.State,
	): Attention | undefined => {
		const now = attentionOf(state);
		return now === attentionOf(seen) ? undefined : now;
	};

	/** The state this machine's tick last saw run `runId` in. */
	export const seen = (
		host: Store,
		runId: string,
	): Promise<Result<Runs.State | undefined>> =>
		host.store.read((db) => {
			const { z } = host;
			const row = z
				.object({
					state: z.enum(["live", "running", "waiting", "idle", "ended"]),
				})
				.nullable()
				.safeParse(
					db.query(`SELECT state FROM ${SEEN} WHERE run_id = ?`).get(runId),
				);
			if (!row.success) return err(new Error(`${SEEN}: ${row.error.message}`));
			return ok(row.data?.state);
		});

	export const setSeen = (
		host: Store,
		runId: string,
		state: Runs.State,
	): Promise<Result<void>> =>
		host.store.write((tx) => {
			tx.db.run(
				`INSERT INTO ${SEEN} (run_id, state, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(run_id) DO UPDATE SET state = excluded.state,
				   updated_at = excluded.updated_at`,
				[runId, state, new Date().toISOString()],
			);
			return ok(undefined);
		});
}
