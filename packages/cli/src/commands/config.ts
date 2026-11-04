import { err, ok, type Result, trySync } from "@cabane/core";
import { failure, type Outcome, success, usage } from "@cabane/extension";
import { z } from "zod";
import {
	ConfigSchema,
	configPath,
	loadConfigDocument,
	saveConfig,
} from "../config";
import type { Command } from "../context";
import { Extensions } from "../extensions";

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

const display = (value: unknown): string =>
	value === undefined
		? "default"
		: typeof value === "string"
			? value
			: JSON.stringify(value);

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
): Outcome => {
	if (identities.has(entry.key))
		return failure(
			`${entry.key} is read-only: actor and device identities cannot be changed or removed here.`,
		);
	if (unwrap(entry.schema) instanceof z.ZodObject)
		return failure(
			`${entry.key} is a config group; set or unset its dotted keys individually.`,
		);
	const parsed = input !== undefined ? parseValue(entry, input) : ok(undefined);
	if (!parsed.ok) return failure(parsed.error);
	if (editStored(stored, entry.key, parsed.value)) {
		const saved = saveConfig(home, stored);
		if (!saved.ok) return failure(saved.error);
	}
	if (entry.key === "extensions" && input !== undefined)
		Extensions.enabled(home);
	return input === undefined
		? success({ key: entry.key, unset: true }, `${entry.key} = default`)
		: success(
				{ key: entry.key, value: parsed.value },
				`${entry.key} = ${display(parsed.value)}`,
			);
};

export const config: Command = {
	name: "config",
	summary: "List, get, set or unset device config; show its path",
	usage:
		"kabane config [list|get <key>|set <key> <value>|unset <key>|path] [--json]",
	standalone: true,
	run: async (args, ctx) => {
		const [sub = "list", key, input] = args.positionals;
		const count = { list: 1, path: 1, get: 2, set: 3, unset: 2 };
		if (!Object.hasOwn(count, sub))
			return usage(`Unknown config subcommand: ${sub}`, config.usage);
		const expected = count[sub as keyof typeof count];
		if (
			args.positionals.length !== expected &&
			!(sub === "list" && args.positionals.length === 0)
		)
			return usage(`Wrong arguments for config ${sub}`, config.usage);
		if (Object.keys(args.flags).length > 0)
			return usage(
				"Unknown config option; use -- before a value beginning with --",
				config.usage,
			);
		if (sub === "path")
			return success(configPath(ctx.home), configPath(ctx.home));
		const loaded = loadConfigDocument(ctx.home);
		if (!loaded.ok) return failure(loaded.error);
		const { stored, config: resolved } = loaded.value;
		if (sub === "list") {
			const rows = keys.map(({ key, description }) => ({
				key,
				value: valueAt(resolved, key) ?? null,
				default: valueAt(stored, key) === undefined,
				readOnly: identities.has(key),
				description,
			}));
			return success(
				rows,
				rows
					.map(
						(row) =>
							`${row.key} = ${row.default ? "default" : display(row.value)} — ${row.description}`,
					)
					.join("\n"),
			);
		}
		const entry = keys.find((entry) => entry.key === key);
		if (!entry)
			return failure(
				`Unknown config key: ${key}. Run \`kabane config list\` for known keys.`,
			);
		if (sub === "get") {
			const value = valueAt(resolved, entry.key);
			return success(value ?? null, display(value));
		}
		return writeSetting(ctx.home, stored, entry, input);
	},
};
