/**
 * Storage — Initialization & Clear
 *
 * `init` is idempotent and cheap, so every host calls it at boot: it applies
 * whatever numbered migrations the database has not had yet (`migrations.ts`),
 * each once and each in its own transaction. On a current database that is one
 * read of the version table. A failed migration is reported with its number and
 * leaves the database at the version before it.
 */

import { ok, type Result } from "../result";
import { withDb } from "../runtime";
import { TABLES } from "./helpers";
import { Migrations } from "./migrations";

export namespace Planner {
	export const init = async (basePath: string): Promise<Result<void>> => {
		const migrated = await withDb(basePath, (db) => Migrations.apply(db));
		if (!migrated.ok) return migrated;
		if (!migrated.value.ok) return migrated.value;
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
