/**
 * Storage — Initialization & Clear
 *
 * `init` is idempotent and cheap, so every host calls it at boot: the schema
 * is IF NOT EXISTS throughout, migrations are guarded by column checks, and
 * the legacy capture triggers are dropped if a pre-explicit-capture database
 * still carries them. Order matters: tables, then migration-added columns.
 */

import { applySchema } from "../db/schema";
import { ok, type Result } from "../result";
import { withDb } from "../runtime";
import { runMigrations, TABLES } from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	export const init = async (basePath: string): Promise<Result<void>> => {
		const schema = await withDb(basePath, (db) => applySchema(db));
		if (!schema.ok) return schema;

		const migrations = await runMigrations(basePath);
		if (!migrations.ok) return migrations;

		const legacy = await withDb(basePath, (db) => Oplog.dropLegacyTriggers(db));
		if (!legacy.ok) return legacy;
		if (!legacy.value.ok) return legacy.value;
		return ok(undefined);
	};

	export const clearAll = async (basePath: string): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			db.run(`DELETE FROM ${TABLES.agent_activities}`);
			db.run(`DELETE FROM ${TABLES.agent_sessions}`);
			db.run(`DELETE FROM ${TABLES.upstream_links}`);
			db.run(`DELETE FROM ${TABLES.activity}`);
			db.run(`DELETE FROM ${TABLES.context_refs}`);
			db.run(`DELETE FROM ${TABLES.work_log}`);
			db.run(`DELETE FROM ${TABLES.comments}`);
			db.run(`DELETE FROM ${TABLES.proposals}`);
			db.run(`DELETE FROM ${TABLES.focus_lists}`);
			db.run(`DELETE FROM ${TABLES.task_links}`);
			db.run(`DELETE FROM ${TABLES.tasks}`);
		});
	};
}
