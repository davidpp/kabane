import {
	atomic,
	CustomAttributeKeySchema,
	defineTool,
	err,
	ok,
	normalizeScopeUri,
	Oplog,
	Planner,
	Runtime,
	setCustomAttribute,
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

export namespace Registry {
	export const publish = (basePath: string, scope: string, input: unknown) => {
		const normalized = normalizeScopeUri(scope);
		if (!normalized.ok) return Promise.resolve(normalized);
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
	],
	// A publication ULID orders competing first writes even for one actor in the same millisecond.
	syncTables: [
		{ table, family: "row-lww", childOfTasks: false, clock: "publication" },
	],
	tools: [
		defineTool({
			name: "kabane_registryPublish",
			kind: "write",
			description:
				"Publish an immutable vocabulary of named choices for one exact scope. Repeating the same declaration is safe.",
			input: { scopeUri: z.string(), declaration },
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
