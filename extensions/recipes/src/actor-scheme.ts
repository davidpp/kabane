import type { KabaneModule } from "@kabane/extension";

/**
 * A recipes table's migration for the actor scheme's rename: `cabane://actor/` became
 * `kabane://actor/` (kabane's core migration 12, JCAB-607). An extension imports no value from
 * kabane's packages, so the prefixes are written here.
 */
export const actorScheme = (
	table: string,
): NonNullable<KabaneModule["migrations"]>[number] => ({
	name: "actor-scheme",
	up: (db) =>
		db.run(
			`UPDATE ${table} SET updated_by = 'kabane://actor/' || substr(updated_by, 16)
			  WHERE substr(updated_by, 1, 15) = 'cabane://actor/'`,
		),
});
