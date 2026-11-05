/**
 * Data modules — a package that owns replicated tables without editing core.
 *
 * A module brings its own numbered migrations and declares which of its tables
 * replicate and how they resolve. A host registers the modules it ships with
 * `Runtime.configure({ modules })`; core then migrates them after its own
 * schema, captures their writes like its own, resolves their ops with the same
 * families, and backfills their rows.
 *
 * A DEVICE WITHOUT A MODULE PARKS ITS OPS. Every op a module's table captures
 * goes out tagged with the module's name and schema version. A device that has
 * not registered that module, or runs an older version of it, stores the op
 * untouched (`sync_parked`) and keeps pulling; the next sync pass after the
 * module registers or migrates applies those ops in log order. Core ops keep
 * their own gate: a pull stops at an op from a newer core schema.
 *
 * The registry is process-wide, like the table prefix (`db/tables.ts`), and is
 * set only through `Runtime.configure`, which validates it first.
 */

import type { Migrate } from "./db/migrate";
import { LOGICAL_TABLES, physicalTable } from "./db/tables";
import { err, ok, type Result } from "./result";
import type { SyncFamily } from "./sync/resolve";

/**
 * One replicated table a module owns.
 *
 * Core resolves the table's ops; the module keeps its rows replicable. Every
 * row needs an `id` primary key (a ULID), and the columns every replicated
 * table carries: `updated_by` (the runtime actor), `version` (1, then + 1 on
 * every local update) and `visibility` (`shared` by default; a `private` row
 * never enters the oplog). Every write ends with `Oplog.afterWrite`, every
 * delete snapshots first and ends with `Oplog.afterDelete`, exactly as core's
 * storage does. Core cannot check any of that from here, so a test in the
 * module has to.
 */
export type ModuleSyncTable = {
	/**
	 * Logical name, without the table prefix; SQL addresses it as
	 * `physicalTable(table)`, resolved inside a function, never captured at import.
	 */
	table: string;
	/**
	 * How an incoming op resolves against the local row. `row-lww` or
	 * `append-only`: the natural-key families need a declared key, which this
	 * contract does not carry yet, so registration refuses them.
	 */
	family: SyncFamily;
	/** LWW clock column. Absent: the op's capture time is the clock. */
	clock?: string;
	/**
	 * The row's `task_id` references `tasks(id) ON DELETE CASCADE`. An op whose
	 * task is gone is skipped as an orphan, and deleting a task captures these
	 * rows' deletes first (`Oplog.cascadeOf`).
	 */
	childOfTasks: boolean;
};

export type KabaneModule = {
	/** Namespace: keys the module's migration versions, op tags and parked ops. [a-z][a-z0-9-]* */
	name: string;
	/**
	 * Append-only, like core's; version = index + 1 within this module, recorded
	 * in the module's own version table. Never edit or reorder a shipped one.
	 */
	migrations?: readonly Migrate.Migration[];
	/** Tables whose rows replicate. A table's ops go out tagged with this module. */
	syncTables?: readonly ModuleSyncTable[];
};

/** A registered module's table, with the module that owns it. */
type ModuleTableRef = { module: KabaneModule; spec: ModuleSyncTable };

/** What a module op carries on the wire (`SyncOp.module`). */
type ModuleTag = { name: string; schema: number };

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const TABLE_NAME = /^[a-z][a-z0-9_]*$/;
const RESOLVABLE: readonly SyncFamily[] = ["row-lww", "append-only"];

let registered: readonly KabaneModule[] = [];

const tableProblem = (
	module: KabaneModule,
	spec: ModuleSyncTable,
	claimed: Map<string, string>,
): string | undefined => {
	const where = `module "${module.name}" table "${spec.table}"`;
	if (!TABLE_NAME.test(spec.table))
		return `${where}: a table name is lowercase letters, digits and underscores, starting with a letter`;
	const owner = claimed.get(spec.table);
	if (owner !== undefined)
		return `${where}: the name is already ${owner === "core" ? "a core table" : `a table of module "${owner}"`}; pick another`;
	if (!RESOLVABLE.includes(spec.family))
		return `${where}: family "${spec.family}" needs a natural key the module contract does not declare; use ${RESOLVABLE.join(" or ")}`;
	return undefined;
};

/** The first thing wrong with `modules`, in one line, or undefined. */
const problemWith = (modules: readonly KabaneModule[]): string | undefined => {
	const names = new Set<string>();
	const claimed = new Map<string, string>(
		Object.values(LOGICAL_TABLES).map((table) => [table, "core"]),
	);
	for (const module of modules) {
		if (!MODULE_NAME.test(module.name))
			return `module name "${module.name}" must be lowercase letters, digits and dashes, starting with a letter`;
		if (names.has(module.name))
			return `two modules are named "${module.name}"; register each once`;
		names.add(module.name);
		for (const spec of module.syncTables ?? []) {
			const problem = tableProblem(module, spec, claimed);
			if (problem !== undefined) return problem;
			claimed.set(spec.table, module.name);
		}
	}
	return undefined;
};

/**
 * Validate and register `modules`, replacing the previous set. Refuses two
 * modules with one name and a table another module or core already has, and
 * registers nothing when it refuses.
 */
export const setModules = (modules: readonly KabaneModule[]): Result<void> => {
	const problem = problemWith(modules);
	if (problem !== undefined)
		return err(new Error(`Runtime.configure: ${problem}.`));
	registered = [...modules];
	return ok(undefined);
};

export namespace Modules {
	/** The registered modules, in registration order. */
	export const list = (): readonly KabaneModule[] => registered;

	/** The registered module called `name`. */
	export const named = (name: string): KabaneModule | undefined =>
		registered.find((module) => module.name === name);

	/** The schema version this build of `module` writes: its migration count. */
	export const schemaOf = (module: KabaneModule): number =>
		module.migrations?.length ?? 0;

	/**
	 * Every registered replicated table, modules in registration order and each
	 * module's tables in declaration order, which is the order backfill emits
	 * them in: declare a parent table before its children.
	 */
	export const tables = (): ModuleTableRef[] =>
		registered.flatMap((module) =>
			(module.syncTables ?? []).map((spec) => ({ module, spec })),
		);

	/** The registered module table called `logical`, if any. */
	export const table = (logical: string): ModuleTableRef | undefined =>
		tables().find((ref) => ref.spec.table === logical);

	/** The tag an op on `logical` goes out with, or undefined for a core table. */
	export const tagFor = (logical: string): ModuleTag | undefined => {
		const ref = table(logical);
		return ref === undefined
			? undefined
			: { name: ref.module.name, schema: schemaOf(ref.module) };
	};

	/**
	 * The physical table recording `name`'s migration versions, apart from
	 * core's `schema_migrations`. A dash becomes an underscore; module names
	 * cannot hold underscores, so two names never share a table.
	 */
	export const versionTable = (name: string): string =>
		physicalTable(`schema_migrations_${name.replaceAll("-", "_")}`);
}
