/**
 * Storage — Initialization
 *
 * `init` is idempotent and cheap, so every host calls it at boot: it applies
 * whatever numbered migrations the database has not had yet (`migrations.ts`),
 * each once and each in its own transaction. On a current database that is one
 * read of the version table. A failed migration is reported with its number and
 * leaves the database at the version before it. The registered data modules
 * (`module.ts`) migrate after core, each against its own version table.
 */

import { ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";
import { Migrations } from "./migrations";

export namespace Planner {
	export const init = async (basePath: string): Promise<Result<void>> => {
		const migrated = await withDb(basePath, (db) => {
			const core = Migrations.apply(db);
			if (!core.ok) return core;
			return Migrations.applyModules(db, Runtime.modules());
		});
		if (!migrated.ok) return migrated;
		if (!migrated.value.ok) return migrated.value;
		return ok(undefined);
	};
}
