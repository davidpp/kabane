// Where a job's schedule lives: one row per item of kind `job`, in the extension's own replicated
// table, and this machine's folder for each scope, which never leaves it. Nothing outside this file
// knows either table.
import type { Host, KabaneModule, Result } from "@cabane/extension";
import { err, ok, trySync } from "./result";
import type { Runs } from "./runs";

export namespace Jobs {
	export type Job = {
		/** The job item's id. */
		taskId: string;
		/** A cron expression, read in this machine's time zone. */
		schedule: string;
		recipe: string;
		inputs: Record<string, unknown>;
		/** The command this job starts instead of `recipes.harness`. */
		harness?: string[];
		lastFiredAt?: string;
		createdAt: string;
	};

	const TABLE = "recipes_jobs";
	const ROOTS = "recipes_roots";

	type Store = Pick<Host, "store" | "z">;

	export const module = (): KabaneModule => ({
		name: "recipes-jobs",
		migrations: [
			{
				name: "create-recipes-jobs",
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
			? z.record(z.unknown()).safeParse(inputs.value)
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
			recipe: data.recipe,
			inputs: parsedInputs.data,
			...(parsedHarness.data === null ? {} : { harness: parsedHarness.data }),
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
				`INSERT INTO ${TABLE} (id, task_id, schedule, recipe, inputs, harness, last_fired_at,
				   created_at, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					job.taskId,
					job.taskId,
					job.schedule,
					job.recipe,
					JSON.stringify(job.inputs),
					job.harness === undefined ? null : JSON.stringify(job.harness),
					job.lastFiredAt ?? null,
					job.createdAt,
					new Date().toISOString(),
					actor,
				],
			);
			const captured = tx.afterWrite(TABLE, "insert", job.taskId);
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
	 * What a fire does, given this machine's runs of the job as their runtime reports them: skip
	 * while one is in flight, otherwise stop the idle ones (a harness stays at its prompt after
	 * its turn) and start a new one.
	 */
	type Fire =
		| { kind: "skip"; run: Runs.Run }
		| { kind: "start"; stop: Runs.Run[] };

	export const decide = (runs: readonly Runs.Run[]): Fire => {
		const busy = runs.find((run) =>
			(["live", "running", "waiting"] as Runs.State[]).includes(run.state),
		);
		return busy
			? { kind: "skip", run: busy }
			: { kind: "start", stop: runs.filter((run) => run.state === "idle") };
	};
}
