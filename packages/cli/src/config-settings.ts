import { Harnesses } from "@cabane/acp/harnesses";
import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";
import {
	ConfigSchema,
	describeIssues,
	isPlainObject,
	loadConfigDocument,
	saveConfig,
} from "./config";
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
// Groups an agent should leave to the human: a wrong value disconnects the device
// or points it at another database. Writable here on purpose, since `kabane config`
// is how the human changes them; the copilot is told to refuse any key flagged so.
const protectedGroups = ["sync", "db"];
const isProtected = (key: string): boolean =>
	protectedGroups.some((group) => key === group || key.startsWith(`${group}.`));
// Credentials: reads, and the echo of a write, say only whether one is set, so a
// help question never puts the hub token or an Access secret in a model's context.
const secrets = new Set(["sync.token", "sync.headers"]);
const REDACTED = "<set>";

const valueAt = (value: unknown, key: string): unknown => {
	for (const part of key.split(".")) {
		if (!isPlainObject(value) || !Object.hasOwn(value, part)) return undefined;
		value = value[part];
	}
	return value;
};

/** Hides secret keys, and the secrets nested in a group's value. */
const redact = (key: string, value: unknown): unknown => {
	if (value === undefined) return undefined;
	if (secrets.has(key)) return REDACTED;
	if (!isPlainObject(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([name, inner]) => [
			name,
			redact(`${key}.${name}`, inner),
		]),
	);
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
		: err(
				new Error(
					`Invalid value for ${entry.key}: ${describeIssues(parsed.error)}`,
				),
			);
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
		if (isPlainObject(child)) parent = child;
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
	// The schema keeps any string so a config from a newer kabane still loads; a new value must
	// be one this build can launch, or `kabane board` refuses to open.
	if (
		entry.key === "copilot.harness" &&
		typeof parsed.value === "string" &&
		!Harnesses.isId(parsed.value)
	)
		return err(
			new Error(
				`Unknown copilot harness "${parsed.value}"; one of ${Harnesses.IDS.join(", ")}`,
			),
		);
	if (editStored(stored, entry.key, parsed.value)) {
		const saved = saveConfig(home, stored);
		if (!saved.ok) return saved;
	}
	if (input === undefined) return ok({ key: entry.key, unset: true });
	const change = { key: entry.key, value: redact(entry.key, parsed.value) };
	// Saved anyway, since a newer kabane may ship the name, but it loads nothing here.
	const ignored =
		entry.key === "extensions" && Array.isArray(parsed.value)
			? Extensions.unshipped(parsed.value)
			: [];
	return ok(ignored.length > 0 ? { ...change, ignored } : change);
};

type ConfigChange = {
	key: string;
	value?: unknown;
	unset?: true;
	/** Extension names saved that this build does not ship. */
	ignored?: string[];
};

export namespace ConfigSettings {
	export const list = (home: string) => {
		const loaded = loadConfigDocument(home);
		if (!loaded.ok) return loaded;
		const { stored, config } = loaded.value;
		return ok(
			keys.map(({ key, description }) => ({
				key,
				value: redact(key, valueAt(config, key)) ?? null,
				default: valueAt(stored, key) === undefined,
				readOnly: identities.has(key),
				protected: isProtected(key),
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
		return loaded.ok
			? ok(redact(key, valueAt(loaded.value.config, key)))
			: loaded;
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
