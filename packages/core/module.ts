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
import type { Db } from "./db/port";
import { LOGICAL_TABLES, physicalTable } from "./db/tables";
import { CORE_TOOL_NAMES } from "./mcp/tool-names";
import type { ToolDef } from "./mcp/tools";
import { err, ok, type Result } from "./result";
import {
	CONTEXT_SECTIONS,
	type ContextSection,
	type ResolvedAssembleContextOpts,
} from "./schemas/assemble-context";
import {
	DEFAULT_ENTRY_KIND,
	type EntryKind,
	EntryKindSchema,
} from "./schemas/comment";
import type { Task, TaskState } from "./schemas/task";
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
 * module has to. The one FK core knows about is `childOfTasks`: a reference
 * from one module table to another is not checked before apply, so an op whose
 * parent row is still parked would fail its whole pull.
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
	/**
	 * LWW clock column, required for `row-lww`: without one the local row has
	 * nothing to compare and the devices never converge. For `append-only`,
	 * absent means the op's capture time.
	 */
	clock?: string;
	/**
	 * The row's `task_id` references `tasks(id) ON DELETE CASCADE`. An op whose
	 * task is gone is skipped as an orphan, and deleting a task captures these
	 * rows' deletes first (`Oplog.cascadeOf`).
	 */
	childOfTasks: boolean;
};

export type ModuleContextSection = {
	/** Namespaced section key: <module>.<key>. */
	name: string;
	/** Core section it renders after. */
	after: ContextSection;
	/** null omits an empty section. */
	render: (
		basePath: string,
		task: Task,
		opts: ResolvedAssembleContextOpts,
	) => Promise<Result<string | null>>;
};

/**
 * The section a kind projected as `latest` renders as: `<kind>.latest`, after
 * the core section its declaration names, valid wherever a module section is.
 */
export type LatestKindSection = {
	name: string;
	after: ContextSection;
	framing: string;
	kind: EntryKind;
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
	contextSections?: readonly ModuleContextSection[];
	/**
	 * Timeline entry kinds, each named after the module (`<module>` or
	 * `<module>.<key>`). Data only: what a kind is and how the brief projects
	 * it, never how to render it.
	 */
	kinds?: readonly EntryKind[];
	tools?: readonly ToolDef[];
	/** Appended to the MCP server instructions, one paragraph. */
	instructions?: string;
	/**
	 * Called inside the transaction of every local change to a task's state
	 * (`Planner.updateTaskIn`), after the task row is written and captured, with
	 * the task as it now is. A write here captures through the oplog like any
	 * module write. Ops applied by sync never call it: the device that changed
	 * the state already captured what the hook wrote. An `err` rolls the state
	 * change back with everything else in its transaction.
	 */
	onTaskStateChange?: (
		db: Db,
		task: Task,
		from: TaskState,
		to: TaskState,
	) => Result<void>;
};

/** A registered module's table, with the module that owns it. */
type ModuleTableRef = { module: KabaneModule; spec: ModuleSyncTable };

/** What a module op carries on the wire (`SyncOp.module`). */
type ModuleTag = { name: string; schema: number };

const MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const TABLE_NAME = /^[a-z][a-z0-9_]*$/;
const RESOLVABLE: readonly SyncFamily[] = ["row-lww", "append-only"];

let registered: readonly KabaneModule[] = [];

/** Logical name of the table recording `name`'s migration versions. */
const versionTableName = (name: string): string =>
	`schema_migrations_${name.replaceAll("-", "_")}`;

/** Table name → what already holds it, worded for an error message. */
type Claims = Map<string, string>;

const tableProblem = (
	module: KabaneModule,
	spec: ModuleSyncTable,
	claimed: Claims,
): string | undefined => {
	const where = `module "${module.name}" table "${spec.table}"`;
	if (!TABLE_NAME.test(spec.table))
		return `${where}: a table name is lowercase letters, digits and underscores, starting with a letter`;
	const owner = claimed.get(spec.table);
	if (owner !== undefined)
		return `${where}: the name is already ${owner}; pick another`;
	if (!RESOLVABLE.includes(spec.family))
		return `${where}: family "${spec.family}" needs a natural key the module contract does not declare; use ${RESOLVABLE.join(" or ")}`;
	// Without a clock the local row has none to compare, every incoming write
	// wins, and two devices editing one row end up holding each other's value.
	if (spec.family === "row-lww" && spec.clock === undefined)
		return `${where}: family "row-lww" needs a clock column (its updated_at, say) to compare writes by`;
	return undefined;
};

/** The section a kind projected as `latest` renders as. */
const latestSectionName = (kind: string): string => `${kind}.latest`;

const kindProblem = (
	module: KabaneModule,
	kind: EntryKind,
	kinds: Claims,
	sections: Claims,
): string | undefined => {
	const where = `module "${module.name}" kind "${kind.name}"`;
	const parsed = EntryKindSchema.safeParse(kind);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path.join(".") || "the declaration";
		const message =
			issue === undefined || issue.code === "invalid_union"
				? `must be "discussion" or { latest: { after: <core section>, framing: <one line> } }`
				: issue.message;
		return `${where}: ${field} ${message}`;
	}
	if (kind.name === DEFAULT_ENTRY_KIND)
		return `${where}: "${DEFAULT_ENTRY_KIND}" is core's own kind; pick another`;
	if (kind.name !== module.name && !kind.name.startsWith(`${module.name}.`))
		return `${where}: the name must be "${module.name}" or start with "${module.name}."`;
	const owner = kinds.get(kind.name);
	if (owner !== undefined)
		return `${where}: the name is already ${owner}; pick another`;
	if (kind.projection !== "discussion") {
		const section = latestSectionName(kind.name);
		const holder = sections.get(section);
		if (holder !== undefined)
			return `${where}: its section "${section}" is already ${holder}; pick another`;
	}
	return undefined;
};

const readSurfaceProblem = (
	modules: readonly KabaneModule[],
): string | undefined => {
	const sections: Claims = new Map(
		CONTEXT_SECTIONS.map((name) => [name, "a core section"]),
	);
	const tools: Claims = new Map(
		Object.values(CORE_TOOL_NAMES).map((name) => [name, "a core tool"]),
	);
	const kinds: Claims = new Map();
	for (const module of modules) {
		for (const section of module.contextSections ?? []) {
			const owner = sections.get(section.name);
			if (owner !== undefined)
				return `module "${module.name}" section "${section.name}": the name is already ${owner}; pick another`;
			if (!section.name.startsWith(`${module.name}.`))
				return `module "${module.name}" section "${section.name}": the name must start with "${module.name}."`;
			sections.set(section.name, `a section of module "${module.name}"`);
		}
		for (const kind of module.kinds ?? []) {
			const problem = kindProblem(module, kind, kinds, sections);
			if (problem !== undefined) return problem;
			kinds.set(kind.name, `a kind of module "${module.name}"`);
			if (kind.projection !== "discussion")
				sections.set(
					latestSectionName(kind.name),
					`the section of kind "${kind.name}"`,
				);
		}
		for (const tool of module.tools ?? []) {
			const owner = tools.get(tool.name);
			if (owner !== undefined)
				return `module "${module.name}" tool "${tool.name}": the name is already ${owner}; pick another`;
			tools.set(tool.name, `a tool of module "${module.name}"`);
		}
	}
	return undefined;
};

/** The first thing wrong with `modules`, in one line, or undefined. */
const problemWith = (modules: readonly KabaneModule[]): string | undefined => {
	const claimed: Claims = new Map(
		Object.values(LOGICAL_TABLES).map((table) => [table, "a core table"]),
	);
	// Every module's migration table is reserved before any table is checked,
	// so no module can declare one, its own or a later module's.
	for (const module of modules) {
		if (!MODULE_NAME.test(module.name))
			return `module name "${module.name}" must be lowercase letters, digits and dashes, starting with a letter`;
		const versions = versionTableName(module.name);
		if (claimed.has(versions))
			return `two modules are named "${module.name}"; register each once`;
		claimed.set(versions, `the migration table of module "${module.name}"`);
	}
	for (const module of modules) {
		for (const spec of module.syncTables ?? []) {
			const problem = tableProblem(module, spec, claimed);
			if (problem !== undefined) return problem;
			claimed.set(spec.table, `a table of module "${module.name}"`);
		}
	}
	return readSurfaceProblem(modules);
};

/**
 * Validate and register `modules`, replacing the previous set. Refuses two
 * modules with one name, a table core, another module or a module's migration
 * table already has, a natural-key family and a `row-lww` table without a
 * clock. Also refuses section namespace/uniqueness violations, tool-name
 * collisions, and a kind that is malformed, outside its module's namespace,
 * core's own `comment`, already declared, or projected into a section name
 * already taken. Registers nothing when it refuses.
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

	/** The sections `module`'s kinds projected as `latest` render as, in declaration order. */
	export const latestSections = (module: KabaneModule): LatestKindSection[] =>
		(module.kinds ?? []).flatMap((kind) =>
			kind.projection === "discussion"
				? []
				: [
						{
							name: latestSectionName(kind.name),
							after: kind.projection.latest.after,
							framing: kind.projection.latest.framing,
							kind,
						},
					],
		);

	/** The registered entry kind called `name`, if a module declares one. */
	export const kind = (name: string): EntryKind | undefined =>
		registered
			.flatMap((module) => module.kinds ?? [])
			.find((declared) => declared.name === name);

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

	/** Run every registered module's `onTaskStateChange`, stopping at the first `err`. */
	export const taskStateChanged = (
		db: Db,
		task: Task,
		from: TaskState,
		to: TaskState,
	): Result<void> => {
		for (const module of registered) {
			const result = module.onTaskStateChange?.(db, task, from, to);
			if (result !== undefined && !result.ok) return result;
		}
		return ok(undefined);
	};

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
		physicalTable(versionTableName(name));
}
