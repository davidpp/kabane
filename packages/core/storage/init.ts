/**
 * Storage — Initialization
 *
 * `init` is idempotent and cheap, so every host calls it at boot: it applies
 * whatever numbered migrations the database has not had yet (`migrations.ts`),
 * each once and each in its own transaction. On a current database that is one
 * read of the version table. A failed migration is reported with its number and
 * leaves the database at the version before it.
 */

import { ok, type Result } from "../result";
import { withDb } from "../runtime";
import { Migrations } from "./migrations";

export namespace Planner {
	export const init = async (basePath: string): Promise<Result<void>> => {
		const migrated = await withDb(basePath, (db) => Migrations.apply(db));
		if (!migrated.ok) return migrated;
		if (!migrated.value.ok) return migrated.value;
		return ok(undefined);
	};
}
