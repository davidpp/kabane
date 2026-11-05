import { realpathSync } from "node:fs";
import { Harnesses } from "@cabane/acp/harnesses";
import { err, ok, type Result, ScopeUri, trySync } from "@cabane/core";
import { Settings } from "@cabane/extension";
import { z } from "zod";
import {
	ConfigSchema,
	configPath,
	describeIssues,
	isPlainObject,
	loadConfigDocument,
	saveConfig,
} from "./config";
import { ConfigLayers } from "./config-layers";
import { projectAt } from "./context";
import { Extensions } from "./extensions";

const { unwrap } = Settings;

type Key = {
	key: string;
	schema: z.ZodTypeAny;
	description: string;
	/** The settings namespace the key belongs to; absent, it is device config. */
	namespace?: Settings.Namespace;
	/** Where it sits in its namespace's document, or in `config.json` for device config. */
	path: readonly string[];
};

const keysOf = (
	schema: z.ZodObject<z.ZodRawShape>,
	parent: Pick<Key, "key" | "path" | "namespace">,
): Key[] =>
	Object.entries(schema.shape).flatMap(([name, field]) => {
		const entry: Key = {
			...parent,
			key: parent.key ? `${parent.key}.${name}` : name,
			schema: field,
			description: field.description ?? "",
			path: [...parent.path, name],
		};
		const inner = unwrap(field);
		return inner instanceof z.ZodObject
			? [entry, ...keysOf(inner, entry)]
			: [entry];
	});

const deviceKeys = keysOf(ConfigSchema, { key: "", path: [] });

const namespaceKeys = (namespace: Settings.Namespace): Key[] => {
	const root: Key = {
		key: namespace.name,
		schema: namespace.schema,
		description:
			namespace.schema.description ??
			`The ${namespace.name} extension's settings; edit dotted keys.`,
		namespace,
		path: [],
	};
	const inner = unwrap(namespace.schema);
	return inner instanceof z.ZodObject ? [root, ...keysOf(inner, root)] : [root];
};

const allKeys = async (): Promise<Result<Key[]>> => {
	const namespaces = await Extensions.namespaces();
	return namespaces.ok
		? ok([...deviceKeys, ...namespaces.value.flatMap(namespaceKeys)])
		: namespaces;
};

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

const valueAt = (value: unknown, path: readonly string[]): unknown => {
	for (const part of path) {
		if (!isPlainObject(value) || !Object.hasOwn(value, part)) return undefined;
		value = value[part];
	}
	return value;
};

// A leaf under a secret is the secret: one header of `sync.headers` is a credential, and its name
// is not listed either.
const secretOf = (key: string): string | undefined =>
	[...secrets].find((secret) => key === secret || key.startsWith(`${secret}.`));

/** Hides secret keys, and the secrets nested in a group's value. */
const redact = (key: string, value: unknown): unknown => {
	if (value === undefined) return undefined;
	if (secretOf(key) !== undefined) return REDACTED;
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
	path: readonly string[],
	value: unknown,
): boolean => {
	const parts = [...path];
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

// Lowest first.
const RANK: readonly Settings.Layer[] = [
	"default",
	"user",
	"project",
	"scope",
	"caller",
];

/** A namespace's resolved settings, or the device config's, with every leaf's origin. */
type View = Settings.Resolved<unknown>;

const viewOf = (
	home: string,
	stored: Record<string, unknown>,
	namespace: Settings.Namespace | undefined,
	where: ConfigSettings.Where,
): Result<View> => {
	// Device config has the user's layer only, already validated by loading it.
	if (namespace === undefined)
		return Settings.resolve("device", ConfigSchema, [
			{ layer: "user", label: configPath(home), value: stored },
		]);
	const sources = ConfigLayers.sources(home, stored, namespace.name, where);
	return sources.ok
		? Settings.resolve(namespace.name, namespace.schema, sources.value)
		: sources;
};

const isUnder = (path: readonly string[], prefix: readonly string[]) =>
	prefix.every((part, i) => path[i] === part);

const dotted = (entry: Key, path: readonly string[]): string =>
	[...(entry.namespace ? [entry.namespace.name] : []), ...path].join(".");

/** Every leaf under `entry` with its origin; the key itself, defaulted, when none is set. */
const leavesUnder = (entry: Key, view: View): View["origins"] => {
	const under = view.origins.filter(({ path }) => isUnder(path, entry.path));
	return under.length > 0
		? under
		: [{ path: entry.path, origin: { layer: "default" } }];
};

/** A group's origin is the highest of its leaves', the one overriding the others. */
const topOrigin = (entry: Key, view: View): Settings.Origin =>
	leavesUnder(entry, view).reduce<Settings.Origin>(
		(top, { origin }) =>
			RANK.indexOf(origin.layer) > RANK.indexOf(top.layer) ? origin : top,
		{ layer: "default" },
	);

/** What `get` says of one leaf: its value and the layer it came from. */
type Leaf = { value: unknown; layer: Settings.Layer; from?: string };

const leavesOf = (entry: Key, view: View): Record<string, Leaf> =>
	Object.fromEntries(
		leavesUnder(entry, view).map(({ path, origin }) => {
			const key = secretOf(dotted(entry, path)) ?? dotted(entry, path);
			const leaf: Leaf = {
				value: redact(key, valueAt(view.value, path)) ?? null,
				layer: origin.layer,
				...(origin.label === undefined ? {} : { from: origin.label }),
			};
			return [key, leaf];
		}),
	);

/** A namespace's record (the loop's gates) takes a key per entry: `loop.gates.test`. */
const recordEntry = (keys: readonly Key[], key: string): Key | undefined => {
	for (const entry of keys) {
		const record = unwrap(entry.schema);
		if (
			!entry.namespace ||
			!(record instanceof z.ZodRecord) ||
			!key.startsWith(`${entry.key}.`)
		)
			continue;
		const name = key.slice(entry.key.length + 1);
		if (!record.keySchema.safeParse(name).success) return undefined;
		return {
			...entry,
			key,
			schema: record.valueSchema,
			path: [...entry.path, name],
		};
	}
	return undefined;
};

const find = (keys: readonly Key[], key: string): Result<Key> => {
	const entry =
		keys.find((entry) => entry.key === key) ?? recordEntry(keys, key);
	return entry
		? ok(entry)
		: err(
				new Error(
					`Unknown config key: ${key}. Run \`kabane config list\` or call kabane_configGet without a key for known keys.`,
				),
			);
};

type ConfigChange = {
	key: string;
	layer: ConfigSettings.Target;
	value?: unknown;
	unset?: true;
	/** Extension names saved that this build does not ship. */
	ignored?: string[];
};

/** The document a write edits, where in it the key goes, and how to save it. */
type Document = {
	value: Record<string, unknown>;
	path: readonly string[];
	/** Where the namespace's block sits in `value`, to validate it on its own. */
	block: readonly string[];
	label: string;
	save: () => Result<string>;
};

const projectDocument = (
	namespace: string,
	entry: Key,
	where: ConfigSettings.Where,
): Result<Document> => {
	if (where.projectDir === undefined)
		return err(
			new Error(
				"No project file here for --layer project: run it from the project's root",
			),
		);
	const file = ConfigLayers.projectFile(where.projectDir, namespace);
	const read = ConfigLayers.readJson(file);
	if (!read.ok) return read;
	const value = read.value ?? {};
	if (!isPlainObject(value))
		return err(
			new Error(`Invalid ${namespace} settings in ${file}: expected an object`),
		);
	return ok({
		value,
		path: entry.path,
		block: [],
		label: file,
		save: () => ConfigLayers.writeJson(file, value),
	});
};

const documentFor = (
	home: string,
	stored: Record<string, unknown>,
	entry: Key,
	layer: ConfigSettings.Target,
	where: ConfigSettings.Where,
): Result<Document> => {
	const inConfig = (block: readonly string[], label: string): Document => ({
		value: stored,
		path: [...block, ...entry.path],
		block,
		label,
		save: () => saveConfig(home, stored),
	});
	const namespace = entry.namespace?.name;
	// A device key has the user's layer only: no project file or scope may redirect the database
	// or the hub.
	if (namespace === undefined)
		return layer === "user"
			? ok(inConfig([], configPath(home)))
			: err(
					new Error(
						`${entry.key} is device config, set for this device only in ${configPath(home)}; it has no ${layer} layer`,
					),
				);
	if (layer === "user") return ok(inConfig([namespace], configPath(home)));
	if (layer === "project") return projectDocument(namespace, entry, where);
	if (where.scopeId === undefined)
		return err(
			new Error(
				"No scope here for --layer scope: run it inside the project, or name one with --scope",
			),
		);
	const block = ConfigLayers.scopeBlock(home, stored, where.scopeId);
	if (!block.ok) return block;
	return ok(
		inConfig(
			[ConfigLayers.SCOPES, where.scopeId, namespace],
			ConfigLayers.scopeLabel(home, where.scopeId),
		),
	);
};

/** Where a write goes: the home, the project and scope it is made in, and the layer it targets. */
type WriteAt = {
	home: string;
	where: ConfigSettings.Where;
	layer: ConfigSettings.Target;
};

const writeSetting = (
	{ home, where, layer }: WriteAt,
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
	const document = documentFor(home, stored, entry, layer, where);
	if (!document.ok) return document;
	const { value, path, block, label, save } = document.value;
	if (editStored(value, path, parsed.value)) {
		// The whole block the key lands in, so an error already in it is named before it is saved.
		if (entry.namespace) {
			const checked = Settings.validate(
				entry.namespace.name,
				entry.namespace.schema,
				{ layer, label, value: valueAt(value, block) ?? {} },
			);
			if (!checked.ok) return checked;
		}
		const saved = save();
		if (!saved.ok) return saved;
	}
	if (input === undefined) return ok({ key: entry.key, layer, unset: true });
	const change = {
		key: entry.key,
		layer,
		value: redact(entry.key, parsed.value),
	};
	// Saved anyway, since a newer kabane may ship the name, but it loads nothing here.
	const ignored =
		entry.key === "extensions" && Array.isArray(parsed.value)
			? Extensions.unshipped(parsed.value)
			: [];
	return ok(ignored.length > 0 ? { ...change, ignored } : change);
};

export namespace ConfigSettings {
	/** The layers a write can target, lowest first. */
	export const TARGETS = ["user", "scope", "project"] as const;
	export type Target = (typeof TARGETS)[number];

	export const isTarget = (layer: string): layer is Target =>
		(TARGETS as readonly string[]).includes(layer);

	/**
	 * Where settings are read and written: the project checkout whose `.kabane/` files are its
	 * project layer, and the scope whose user settings apply.
	 */
	export type Where = ConfigLayers.Where;

	const canonical = (dir: string): string => {
		const real = trySync(() => realpathSync(dir));
		return real.ok ? real.value : dir;
	};

	/**
	 * What a command run in `cwd` reads and writes. The project layer is `cwd`'s own `.kabane/`
	 * when `cwd` is the project's root: the file `kabane loop start` reads from there. `scope` (a
	 * scope URI or id) names whose user settings apply, and drops the project layer when the
	 * project here is another scope.
	 */
	export const locate = async (
		home: string,
		cwd: string,
		scope?: string,
	): Promise<Result<Where>> => {
		const project = await projectAt(cwd, home);
		if (!project.ok) return project;
		const here = project.value;
		const named = scope === undefined ? undefined : ScopeUri.getScopeId(scope);
		const scopeId = named ? (named.ok ? named.value : scope) : here?.scopeId;
		const projectDir =
			here &&
			here.scopeId === scopeId &&
			canonical(cwd) === canonical(here.root)
				? cwd
				: undefined;
		return ok({
			...(projectDir === undefined ? {} : { projectDir }),
			...(scopeId === undefined ? {} : { scopeId }),
		});
	};

	export const list = async (home: string, where: Where) => {
		const keys = await allKeys();
		if (!keys.ok) return keys;
		const loaded = loadConfigDocument(home);
		if (!loaded.ok) return loaded;
		const views = new Map<string | undefined, View>();
		const rows = [];
		for (const entry of keys.value) {
			const name = entry.namespace?.name;
			let view = views.get(name);
			if (view === undefined) {
				const resolved = viewOf(
					home,
					loaded.value.stored,
					entry.namespace,
					where,
				);
				if (!resolved.ok) return resolved;
				view = resolved.value;
				views.set(name, view);
			}
			const origin = topOrigin(entry, view);
			rows.push({
				key: entry.key,
				value: redact(entry.key, valueAt(view.value, entry.path)) ?? null,
				default: origin.layer === "default",
				layer: origin.layer,
				...(origin.label === undefined ? {} : { from: origin.label }),
				readOnly: identities.has(entry.key),
				protected: isProtected(entry.key),
				description: entry.description,
			});
		}
		return ok(rows);
	};

	/** The effective value of `key` at `where`, and every leaf under it with the layer it came from. */
	export const get = async (home: string, where: Where, key: string) => {
		const keys = await allKeys();
		if (!keys.ok) return keys;
		const entry = find(keys.value, key);
		if (!entry.ok) return entry;
		const loaded = loadConfigDocument(home);
		if (!loaded.ok) return loaded;
		const view = viewOf(
			home,
			loaded.value.stored,
			entry.value.namespace,
			where,
		);
		if (!view.ok) return view;
		return ok({
			key,
			value: redact(key, valueAt(view.value.value, entry.value.path)) ?? null,
			leaves: leavesOf(entry.value, view.value),
		});
	};

	/** Set `key` in `layer` at `where`, or remove it from that layer when `input` is undefined. */
	export const set = async (
		home: string,
		where: Where,
		key: string,
		input: string | undefined,
		layer: Target = "user",
	): Promise<Result<ConfigChange>> => {
		const keys = await allKeys();
		if (!keys.ok) return keys;
		const entry = find(keys.value, key);
		if (!entry.ok) return entry;
		const loaded = loadConfigDocument(home);
		return loaded.ok
			? writeSetting(
					{ home, where, layer },
					loaded.value.stored,
					entry.value,
					input,
				)
			: loaded;
	};
}
