import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";
import { ConfigSchema, loadConfigDocument, saveConfig } from "./config";
import { Extensions } from "./extensions";

const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
	if (schema instanceof z.ZodOptional) return unwrap(schema.unwrap());
	if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
	if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
	return schema;
};

type Key = { key: string; schema: z.ZodTypeAny; description: string };

const keysOf = (schema: z.ZodObject<z.ZodRawShape>, prefix = ""): Key[] =>
	Object.entries(schema.shape).flatMap(([name, field]) => {
		const key = prefix ? `${prefix}.${name}` : name;
		const entry = { key, schema: field, description: field.description ?? "" };
		const inner = unwrap(field);
		return inner instanceof z.ZodObject
			? [entry, ...keysOf(inner, key)]
			: [entry];
	});

const keys = keysOf(ConfigSchema);
const identities = new Set(["actor", "deviceId", "sync.deviceId"]);

const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const valueAt = (value: unknown, key: string): unknown => {
	for (const part of key.split(".")) {
		if (!object(value) || !Object.hasOwn(value, part)) return undefined;
		value = value[part];
	}
	return value;
};

const parseValue = (entry: Key, text: string): Result<unknown> => {
	const type = unwrap(entry.schema);
	let value: unknown = text;
	if (type instanceof z.ZodArray) {
		value = text === "" ? [] : text.split(",").map((part) => part.trim());
	} else if (
		type instanceof z.ZodNumber ||
		type instanceof z.ZodBoolean ||
		type instanceof z.ZodRecord
	) {
		const parsed = trySync((): unknown => JSON.parse(text));
		if (!parsed.ok)
			return err(
				new Error(
					`Invalid value for ${entry.key}: expected ${type instanceof z.ZodRecord ? "a JSON object of strings" : type instanceof z.ZodBoolean ? "true or false" : "a number"}.`,
				),
			);
		value = parsed.value;
	}
	const parsed = entry.schema.safeParse(value);
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`Invalid value for ${entry.key}: ${parsed.error.message}`));
};

/** Returns false when an unset has no stored parent, so it need not write. */
const editStored = (
	stored: Record<string, unknown>,
	key: string,
	value: unknown,
): boolean => {
	const parts = key.split(".");
	const leaf = parts.pop();
	if (!leaf) return false;
	let parent = stored;
	for (const part of parts) {
		const child = parent[part];
		if (object(child)) parent = child;
		else {
			// Do not create an absent group and activate its defaults on unset.
			if (value === undefined) return false;
			const created: Record<string, unknown> = {};
			parent[part] = created;
			parent = created;
		}
	}
	if (value === undefined) delete parent[leaf];
	else parent[leaf] = value;
	return true;
};

const writeSetting = (
	home: string,
	stored: Record<string, unknown>,
	entry: Key,
	input: string | undefined,
): Result<ConfigChange> => {
	if (identities.has(entry.key))
		return err(
			new Error(
				`${entry.key} is read-only: actor and device identities cannot be changed or removed here.`,
			),
		);
	if (unwrap(entry.schema) instanceof z.ZodObject)
		return err(
			new Error(
				`${entry.key} is a config group; set or unset its dotted keys individually.`,
			),
		);
	const parsed = input !== undefined ? parseValue(entry, input) : ok(undefined);
	if (!parsed.ok) return parsed;
	if (editStored(stored, entry.key, parsed.value)) {
		const saved = saveConfig(home, stored);
		if (!saved.ok) return saved;
	}
	if (entry.key === "extensions" && input !== undefined)
		Extensions.enabled(home);
	return ok(
		input === undefined
			? { key: entry.key, unset: true }
			: { key: entry.key, value: parsed.value },
	);
};

type ConfigChange = { key: string; value?: unknown; unset?: true };

export namespace ConfigSettings {
	export const list = (home: string) => {
		const loaded = loadConfigDocument(home);
		if (!loaded.ok) return loaded;
		const { stored, config } = loaded.value;
		return ok(
			keys.map(({ key, description }) => ({
				key,
				value: valueAt(config, key) ?? null,
				default: valueAt(stored, key) === undefined,
				readOnly: identities.has(key),
				description,
			})),
		);
	};

	const find = (key: string): Result<Key> => {
		const entry = keys.find((entry) => entry.key === key);
		return entry
			? ok(entry)
			: err(
					new Error(
						`Unknown config key: ${key}. Run \`kabane config list\` or call kabane_configGet without a key for known keys.`,
					),
				);
	};

	export const get = (home: string, key: string): Result<unknown> => {
		const entry = find(key);
		if (!entry.ok) return entry;
		const loaded = loadConfigDocument(home);
		return loaded.ok ? ok(valueAt(loaded.value.config, key)) : loaded;
	};

	export const set = (
		home: string,
		key: string,
		input?: string,
	): Result<ConfigChange> => {
		const entry = find(key);
		if (!entry.ok) return entry;
		const loaded = loadConfigDocument(home);
		return loaded.ok
			? writeSetting(home, loaded.value.stored, entry.value, input)
			: loaded;
	};
}
