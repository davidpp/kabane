import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Migrations, SCHEMA_VERSION } from "./migrations";

const log = (name: string) => env.CABANE_LOG.getByName(name);

const seed = (name: string) =>
	log(name).push({
		deviceId: "device-a",
		ops: [{ opId: "op-1", deviceId: "device-a" }],
	});

const inspect = async <T>(
	name: string,
	read: (sql: SqlStorage) => T,
): Promise<T> =>
	runInDurableObject(log(name), (_i, ctx) => read(ctx.storage.sql));

const versions = (sql: SqlStorage): number[] =>
	sql
		.exec<{ version: number }>(
			"SELECT version FROM _sql_schema_migrations ORDER BY version",
		)
		.toArray()
		.map((r) => r.version);

const tables = (sql: SqlStorage): string[] =>
	sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
		)
		.toArray()
		.map((r) => r.name);

describe("migrations", () => {
	it("creates the schema on construction", async () => {
		await seed("fresh");

		expect(await inspect("fresh", tables)).toEqual([
			"_sql_schema_migrations",
			"devices",
			"oplog",
		]);
		expect(await inspect("fresh", versions)).toEqual([SCHEMA_VERSION]);
	});

	it("is a no-op when applied again", async () => {
		await seed("reapply");

		const applied = await inspect("reapply", (sql) => {
			Migrations.apply(sql);
			Migrations.apply(sql);
			return versions(sql);
		});

		expect(applied).toEqual([SCHEMA_VERSION]);
		expect(await inspect("reapply", (sql) => rowCount(sql))).toBe(1);
	});

	it("does not re-run across a restart", async () => {
		await seed("restart");
		const before = await inspect("restart", appliedAt);

		// Tears the instance down, keeps the storage — the constructor, and so
		// `Migrations.apply`, runs again on the next call.
		await evictDurableObject(log("restart"));
		const ack = await log("restart").push({
			deviceId: "device-a",
			ops: [{ opId: "op-2", deviceId: "device-a" }],
		});

		expect(ack.ok).toBe(true);
		expect(await inspect("restart", versions)).toEqual([SCHEMA_VERSION]);
		// A re-run would have rewritten this timestamp.
		expect(await inspect("restart", appliedAt)).toEqual(before);
		expect(await inspect("restart", rowCount)).toBe(2);
	});
});

const rowCount = (sql: SqlStorage): number =>
	sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oplog").one().n;

const appliedAt = (sql: SqlStorage): string =>
	sql
		.exec<{ applied_at: string }>(
			"SELECT applied_at FROM _sql_schema_migrations WHERE version = ?",
			SCHEMA_VERSION,
		)
		.one().applied_at;
