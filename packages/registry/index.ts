import {
	atomic,
	CORE_THREAD_KINDS,
	CustomAttributeKeySchema,
	defineTool,
	err,
	ok,
	normalizeScopeUri,
	Oplog,
	Planner,
	type Result,
	Runtime,
	setCustomAttribute,
	type ThreadKind,
	ThreadKindSchema,
	withDb,
	type KabaneModule,
} from "@kabane/core";
import { ulid } from "ulid";
import { z } from "zod";

const key = CustomAttributeKeySchema;
const choice = z
	.object({
		value: key,
		label: z.string().min(1).max(100),
		description: z.string().max(500).optional(),
	})
	.strict();
const declaration = z
	.object({
		key,
		description: z.string().min(1).max(500),
		choices: z
			.array(choice)
			.min(1)
			.max(50)
			.refine(
				(choices) =>
					new Set(choices.map((choice) => choice.value)).size ===
					choices.length,
				"Duplicate choice value",
			),
	})
	.strict();
const table = "registry_declarations";
const kindTable = "registry_thread_kinds";

/** Where a discovered thread kind is declared: core, a registered module, or the scope's published vocabulary. */
type KindSource = "core" | `module:${string}` | "scope";
type DiscoveredKind = ThreadKind & { source: KindSource };

/** The declaration in code that holds `name`, if any: a scope never replaces one. */
const declaredInCode = (name: string): KindSource | undefined => {
	if (CORE_THREAD_KINDS.some((kind) => kind.name === name)) return "core";
	const declared = Runtime.threadKinds().find(({ kind }) => kind.name === name);
	return declared && `module:${declared.module}`;
};

const publishKind = (basePath: string, scope: string, kind: ThreadKind) =>
	atomic(basePath, (db) => {
		const owner = declaredInCode(kind.name);
		if (owner !== undefined)
			throw new Error(
				`Thread kind "${kind.name}" is already declared by ${owner}; pick another name.`,
			);
		const id = JSON.stringify([scope, kind.name]);
		const document = JSON.stringify(kind);
		const prior = db
			.query<{ document: string }>(
				`SELECT document FROM ${kindTable} WHERE id = ?`,
			)
			.get(id);
		if (prior && prior.document !== document)
			throw new Error(
				`Scope ${scope} already declares thread kind "${kind.name}" differently; choose a new name.`,
			);
		if (!prior) {
			db.run(
				`INSERT INTO ${kindTable} (id, scope, document, publication, updated_by) VALUES (?, ?, ?, ?, ?)`,
				[id, scope, document, ulid(), Runtime.actor()],
			);
			Oplog.afterWrite(db, kindTable, "insert", id);
		}
		return kind;
	});

export namespace Registry {
	export const publish = (
		basePath: string,
		scope: string,
		input: unknown,
	): Promise<Result<ThreadKind | z.infer<typeof declaration>>> => {
		const normalized = normalizeScopeUri(scope);
		if (!normalized.ok) return Promise.resolve(normalized);
		if (typeof input === "object" && input !== null && "name" in input) {
			const kind = ThreadKindSchema.safeParse(input);
			return kind.success
				? publishKind(basePath, normalized.value, kind.data)
				: Promise.resolve(err(new Error(kind.error.message)));
		}
		const parsed = declaration.safeParse(input);
		if (!parsed.success)
			return Promise.resolve(err(new Error(parsed.error.message)));
		return atomic(basePath, (db) => {
			const id = JSON.stringify([normalized.value, parsed.data.key]);
			const document = JSON.stringify(parsed.data);
			const prior = db
				.query<{ document: string }>(
					`SELECT document FROM ${table} WHERE id = ?`,
				)
				.get(id);
			if (prior && prior.document !== document)
				throw new Error(
					"A different declaration already exists for this scope and key.",
				);
			if (!prior) {
				db.run(
					`INSERT INTO ${table} (id, scope, document, publication, updated_by) VALUES (?, ?, ?, ?, ?)`,
					[id, normalized.value, document, ulid(), Runtime.actor()],
				);
				Oplog.afterWrite(db, table, "insert", id);
			}
			return parsed.data;
		});
	};
	export const list = async (basePath: string, scope: string) => {
		const normalized = normalizeScopeUri(scope);
		if (!normalized.ok) return Promise.resolve(normalized);
		const rows = await withDb(basePath, (db) =>
			db
				.query<{ document: string }>(
					`SELECT document FROM ${table} WHERE scope = ? ORDER BY id`,
				)
				.all(normalized.value)
				.map((row): unknown => JSON.parse(row.document)),
		);
		if (!rows.ok) return rows;
		const parsed = declaration.array().safeParse(rows.value);
		return parsed.success
			? ok(parsed.data)
			: err(new Error(parsed.error.message));
	};
	/**
	 * The thread kinds a reader can file in `scope`: core's, the registered
	 * modules', then the scope's own. A scope kind whose name code also
	 * declares (it arrived by sync, or the module registered after it was
	 * published) is listed under `shadowed`, never in place of the code's.
	 */
	export const kinds = async (basePath: string, scope: string) => {
		const normalized = normalizeScopeUri(scope);
		if (!normalized.ok) return normalized;
		const rows = await withDb(basePath, (db) =>
			db
				.query<{ document: string }>(
					`SELECT document FROM ${kindTable} WHERE scope = ? ORDER BY id`,
				)
				.all(normalized.value)
				.map((row): unknown => JSON.parse(row.document)),
		);
		if (!rows.ok) return rows;
		const published = ThreadKindSchema.array().safeParse(rows.value);
		if (!published.success) return err(new Error(published.error.message));
		const kinds: DiscoveredKind[] = [
			// Identity only: what core does with its own kinds is not a declaration's.
			...CORE_THREAD_KINDS.map(({ name, label, description }) => ({
				name,
				label,
				...(description === undefined ? {} : { description }),
				source: "core" as const,
			})),
			...Runtime.threadKinds().map(({ module, kind }) => ({
				...kind,
				source: `module:${module}` as const,
			})),
		];
		const shadowed: (DiscoveredKind & { by: KindSource })[] = [];
		for (const kind of published.data) {
			const by = declaredInCode(kind.name);
			if (by === undefined) kinds.push({ ...kind, source: "scope" });
			else shadowed.push({ ...kind, source: "scope", by });
		}
		return ok(shadowed.length ? { kinds, shadowed } : { kinds });
	};
	export const set = async (
		basePath: string,
		id: string,
		name: string,
		value: string | null,
	) => {
		const thread = await Planner.resolveTaskId(basePath, id);
		if (!thread.ok) return thread;
		return atomic(basePath, (db) => {
			const task = db
				.query<{ scope_uri: string | null }>(
					"SELECT scope_uri FROM tasks WHERE id = ?",
				)
				.get(thread.value);
			if (!task?.scope_uri) throw new Error("This item has no scope.");
			const row = db
				.query<{ document: string }>(
					`SELECT document FROM ${table} WHERE id = ?`,
				)
				.get(JSON.stringify([task.scope_uri, name]));
			if (!row)
				throw new Error(`No declaration for ${name} in ${task.scope_uri}.`);
			const parsed = declaration.safeParse(JSON.parse(row.document));
			if (!parsed.success) throw new Error(parsed.error.message);
			const spec = parsed.data;
			if (
				value !== null &&
				!spec.choices.some((choice) => choice.value === value)
			)
				throw new Error(
					`Expected one of: ${spec.choices.map((choice) => choice.value).join(", ")}`,
				);
			setCustomAttribute(db, thread.value, name, value);
			return { id: thread.value, key: name, value };
		});
	};
}

export const registryModule: KabaneModule = {
	name: "registry",
	migrations: [
		{
			name: "create-scope-declarations",
			up(db) {
				db.run(
					`CREATE TABLE ${table} (id TEXT PRIMARY KEY, scope TEXT NOT NULL, document TEXT NOT NULL, publication TEXT NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'shared')`,
				);
				db.run(`CREATE INDEX registry_by_scope ON ${table}(scope)`);
			},
		},
		{
			name: "create-scope-thread-kinds",
			up(db) {
				db.run(
					`CREATE TABLE ${kindTable} (id TEXT PRIMARY KEY, scope TEXT NOT NULL, document TEXT NOT NULL, publication TEXT NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'shared')`,
				);
				db.run(`CREATE INDEX registry_kinds_by_scope ON ${kindTable}(scope)`);
			},
		},
	],
	// A publication ULID orders competing first writes even for one actor in the same millisecond.
	syncTables: [
		{ table, family: "row-lww", childOfTasks: false, clock: "publication" },
		{
			table: kindTable,
			family: "row-lww",
			childOfTasks: false,
			clock: "publication",
		},
	],
	tools: [
		defineTool({
			name: "kabane_registryPublish",
			kind: "write",
			description:
				"Publish one declaration for one exact scope: an attribute ({ key, description, choices }) or a thread kind ({ name, label, description? }). Declarations are immutable; repeating the same one is safe. A kind core or a module declares cannot be published.",
			input: {
				scopeUri: z.string(),
				declaration: z.union([declaration, ThreadKindSchema]),
			},
			handler: (args, ctx) =>
				Registry.publish(ctx.basePath, args.scopeUri, args.declaration),
		}),
		defineTool({
			name: "kabane_registry",
			kind: "read",
			description:
				"Read the declared attribute keys, choice values and labels for this exact scope.",
			input: { scopeUri: z.string() },
			handler: (args, ctx) => Registry.list(ctx.basePath, args.scopeUri),
		}),
		defineTool({
			name: "kabane_threadKinds",
			kind: "read",
			description:
				"List the thread kinds that can be filed in this exact scope, each with its name, display label and source (core, module:<name> or scope). A stored kind no declaration covers reads as its name.",
			input: { scopeUri: z.string() },
			handler: (args, ctx) => Registry.kinds(ctx.basePath, args.scopeUri),
		}),
		defineTool({
			name: "kabane_attributeSet",
			kind: "write",
			description:
				"Set one declared attribute on a thread, or clear it with null. Its scope supplies the vocabulary.",
			input: { id: z.string(), key, value: key.nullable() },
			handler: (args, ctx) =>
				Registry.set(ctx.basePath, args.id, args.key, args.value),
		}),
	],
};
