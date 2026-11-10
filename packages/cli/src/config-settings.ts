import { realpathSync } from "node:fs";
import { Harnesses } from "@cabane/acp/harnesses";
import type { SettingField } from "@cabane/board/ports";
import {
	err,
	ok,
	type Result,
	ScopeUri,
	tryCatch,
	trySync,
} from "@cabane/core";
import { mainCheckoutRoot } from "@cabane/core/scope";
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
import { DEVICE_LOOKS } from "./config-looks";
import { projectAt } from "./context";
import { Extensions } from "./extensions";

const { unwrap } = Settings;

type Key = {
	key: string;
	schema: z.ZodTypeAny;
	field: SettingField;
	/** The settings namespace the key belongs to; absent, it is device config. */
	namespace?: Settings.Namespace;
	/** Where it sits in its namespace's document, or in `config.json` for device config. */
	path: readonly string[];
};

const keysOf = (schema: z.ZodTypeAny, namespace?: Settings.Namespace): Key[] =>
	Settings.entries(schema).map(({ field, schema }) => ({
		key: [...(namespace ? [namespace.name] : []), ...field.path].join("."),
		schema,
		field,
		...(namespace ? { namespace } : {}),
		path: field.path,
	}));

const deviceKeys = keysOf(ConfigSchema);

const namespaceKeys = (namespace: Settings.Namespace): Key[] => {
	const field = Settings.field(namespace.schema);
	const root: Key = {
		key: namespace.name,
		schema: namespace.schema,
		field: {
			...field,
			description:
				field.description ??
				`The ${namespace.name} extension's settings; edit dotted keys.`,
		},
		namespace,
		path: [],
	};
	return [root, ...keysOf(namespace.schema, namespace)];
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

/**
 * When a change to a key applies: device keys load once, at a process's start; an extension's
 * settings are read again at each resolve (the loop's at each run it starts).
 */
type Restart = "start" | "resolve";

const restartOf = (entry: Key): Restart =>
	entry.namespace ? "resolve" : "start";

/**
 * How a key reads: its namespace's look for it, or the device's, with the choices it steps through
 * for the project at `where`. A namespace's own key reads as its name.
 */
const lookOf = (entry: Key, where: ConfigSettings.Where) => {
	const look =
		entry.path.length === 0
			? { label: entry.key, group: Settings.OTHER }
			: Settings.lookOf(
					entry.namespace ? entry.namespace.looks : DEVICE_LOOKS,
					entry.path,
				);
	const options = Settings.options(
		entry.field,
		look,
		where.projectDir === undefined ? {} : { projectDir: where.projectDir },
	);
	return {
		label: look.label,
		group: look.group,
		...(options === undefined ? {} : { options }),
		...(look.none === undefined ? {} : { none: look.none }),
	};
};

/**
 * What a row says of a key besides its value: how it reads, its field, the layers it is written
 * to, and more.
 */
const traitsOf = (entry: Key, where: ConfigSettings.Where) => ({
	...lookOf(entry, where),
	field: entry.field,
	// A device key has the global layer only: no project file may redirect the database or the hub.
	layers: entry.namespace ? ConfigSettings.TARGETS : (["global"] as const),
	secret: secretOf(entry.key) !== undefined,
	restart: restartOf(entry),
});

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

// What a value of each kind typed as JSON is expected to be.
const JSON_KINDS: Partial<Record<SettingField["kind"], string>> = {
	number: "a number",
	boolean: "true or false",
	record: "a JSON object of strings",
};

const parseValue = (entry: Key, text: string): Result<unknown> => {
	const { kind } = entry.field;
	const expected = JSON_KINDS[kind];
	let value: unknown = text;
	if (kind === "list") {
		value = text === "" ? [] : text.split(",").map((part) => part.trim());
	} else if (expected !== undefined) {
		const parsed = trySync((): unknown => JSON.parse(text));
		if (!parsed.ok)
			return err(
				new Error(`Invalid value for ${entry.key}: expected ${expected}.`),
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
	"global",
	"shared",
	"local",
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
	// Device config has the global layer only, already validated by loading it.
	if (namespace === undefined)
		return Settings.resolve("device", ConfigSchema, [
			{ layer: "global", label: configPath(home), value: stored },
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
		: [{ path: entry.path, origin: { layer: "default" }, hides: [] }];
};

/** A group's origin is the highest of its leaves', the one overriding the others. */
const topOrigin = (entry: Key, view: View): Settings.Origin =>
	leavesUnder(entry, view).reduce<Settings.Origin>(
		(top, { origin }) =>
			RANK.indexOf(origin.layer) > RANK.indexOf(top.layer) ? origin : top,
		{ layer: "default" },
	);

/** A value a layer holds, and the file (or `scopes` block) it is in. */
type Held = { layer: Settings.Layer; from: string; value: unknown };

/** What `get` says of one leaf: its value, the layer it came from, and what the layers under it say. */
type Leaf = {
	value: unknown;
	layer: Settings.Layer;
	from?: string;
	hides: Held[];
};

const heldOf = (key: string, hides: View["origins"][number]["hides"]): Held[] =>
	hides.map(({ layer, label, value }) => ({
		layer,
		from: label,
		value: redact(key, value),
	}));

const leavesOf = (entry: Key, view: View): Record<string, Leaf> =>
	Object.fromEntries(
		leavesUnder(entry, view).map(({ path, origin, hides }) => {
			const key = secretOf(dotted(entry, path)) ?? dotted(entry, path);
			const leaf: Leaf = {
				value: redact(key, valueAt(view.value, path)) ?? null,
				layer: origin.layer,
				...(origin.label === undefined ? {} : { from: origin.label }),
				hides: heldOf(key, hides),
			};
			return [key, leaf];
		}),
	);

/** What the layers under the one deciding `entry` set at it, lowest first; none for a group. */
const hidesAt = (entry: Key, view: View): Held[] =>
	heldOf(
		entry.key,
		view.origins.find(
			({ path }) =>
				path.length === entry.path.length && isUnder(path, entry.path),
		)?.hides ?? [],
	);

/** The entries a namespace's record holds at `view`, each a key of its own: `loop.gates.test`. */
const entriesOf = (keys: readonly Key[], entry: Key, view: View): Key[] =>
	entry.namespace === undefined || entry.field.kind !== "record"
		? []
		: leavesUnder(entry, view).flatMap(({ path }) => {
				const name = path[entry.path.length];
				const child =
					path.length === entry.path.length + 1 && name !== undefined
						? recordEntry(keys, `${entry.key}.${name}`)
						: undefined;
				return child ? [child] : [];
			});

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
		const path = [...entry.path, name];
		return {
			...entry,
			key,
			schema: record.valueSchema,
			field: Settings.field(record.valueSchema, path),
			path,
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
	/** The file, or `config.json`, the layer is stored in. */
	from: string;
	value?: unknown;
	unset?: true;
	/** A layer above the one written that still sets the key, so the write changed nothing. */
	shadowedBy?: Held;
	/** After an unset, the layer at or under the one written that now decides, if not the default. */
	fallsBackTo?: Held;
	/** Saved, but the layers no longer resolve: why, naming the file at fault. */
	unresolved?: string;
	/** Extension names saved that this build does not ship. */
	ignored?: string[];
	restart: Restart;
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

/** A namespace's document in its own file: a project's shared file or its local one. */
const fileDocument = (
	file: string,
	namespace: string,
	entry: Key,
): Result<Document> => {
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
	const namespace = entry.namespace?.name;
	// A device key has the global layer only: no project file may redirect the database or the hub.
	if (namespace === undefined || layer === "global") {
		if (namespace !== undefined || layer === "global")
			return ok({
				value: stored,
				path: [...(namespace === undefined ? [] : [namespace]), ...entry.path],
				block: namespace === undefined ? [] : [namespace],
				label: configPath(home),
				save: () => saveConfig(home, stored),
			});
		return err(
			new Error(
				`${entry.key} is a device key, set for this device in ${configPath(home)}: it has the global layer only, not ${layer}`,
			),
		);
	}
	if (layer === "shared")
		return where.projectDir === undefined
			? err(
					new Error(
						"No project here for --layer shared: run it from the project's root",
					),
				)
			: fileDocument(
					ConfigLayers.sharedFile(where.projectDir, namespace),
					namespace,
					entry,
				);
	if (where.localRoot === undefined)
		return err(
			new Error(
				`No project here for --layer local: run it inside the project.${where.scopeId === undefined ? "" : ` --scope reads ${ConfigLayers.scopeLabel(home, where.scopeId)} and never writes it.`}`,
			),
		);
	return fileDocument(
		ConfigLayers.localFile(home, where.localRoot, namespace),
		namespace,
		entry,
	);
};

/** Where a write goes: the home, the project and scope it is made in, and the layer it targets. */
type WriteAt = {
	home: string;
	where: ConfigSettings.Where;
	layer: ConfigSettings.Target;
};

/**
 * Who decides `entry` once a write to `layer` (stored in `label`) is saved: a higher layer that
 * still sets it, or, the write being an unset, the stored layer it falls back to. The caller's
 * layer is never stored, so a write never counts it.
 */
const deciding = (
	{ home, where, layer }: WriteAt,
	stored: Record<string, unknown>,
	entry: Key,
	label: string,
): Pick<ConfigChange, "shadowedBy" | "fallsBackTo" | "unresolved"> => {
	// The write is saved by now, so a layer that fails to resolve is reported beside it, not as
	// its failure: every read of the namespace fails until that file is fixed.
	const view = viewOf(home, stored, entry.namespace, where);
	if (!view.ok) return { unresolved: view.error.message };
	const origin = topOrigin(entry, view.value);
	if (origin.layer === "default" || origin.label === undefined) return {};
	const held: Held = {
		layer: origin.layer,
		from: origin.label,
		value: redact(entry.key, valueAt(view.value.value, entry.path)),
	};
	if (RANK.indexOf(origin.layer) > RANK.indexOf(layer))
		return { shadowedBy: held };
	return origin.label === label ? {} : { fallsBackTo: held };
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
	if (entry.field.kind === "group")
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
	const decides = deciding({ home, where, layer }, stored, entry, label);
	if (input === undefined)
		return ok({
			key: entry.key,
			layer,
			from: label,
			unset: true,
			restart: restartOf(entry),
			...decides,
		});
	const change = {
		key: entry.key,
		layer,
		from: label,
		value: redact(entry.key, parsed.value),
		restart: restartOf(entry),
		...(decides.shadowedBy === undefined
			? {}
			: { shadowedBy: decides.shadowedBy }),
		...(decides.unresolved === undefined
			? {}
			: { unresolved: decides.unresolved }),
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
	export const TARGETS = ["global", "shared", "local"] as const;
	export type Target = (typeof TARGETS)[number];

	/** The names the layers had before; accepted on input, never output. */
	const FORMER: Readonly<Record<string, Target>> = {
		user: "global",
		project: "shared",
		scope: "local",
	};

	/** The layer `name` means, a former name included; undefined when it names none. */
	export const targetOf = (name: string): Target | undefined =>
		(TARGETS as readonly string[]).includes(name)
			? (name as Target)
			: Object.hasOwn(FORMER, name)
				? FORMER[name]
				: undefined;

	/**
	 * Where settings are read and written: the checkout whose `.kabane/` is the shared layer, the
	 * project root that keys the local layer, and the scope of the legacy `scopes` block.
	 */
	export type Where = ConfigLayers.Where;

	const canonical = (dir: string): string => {
		const real = trySync(() => realpathSync(dir));
		return real.ok ? real.value : dir;
	};

	/**
	 * What a command run in `cwd` reads and writes. The shared layer is `cwd`'s own `.kabane/`
	 * when `cwd` is the project's root: the file `kabane loop start` reads from there. The local
	 * layer is the project's, from anywhere inside it or a worktree of it. `scope` (a scope URI or
	 * id) naming another project than this one leaves only that scope's legacy `scopes` block:
	 * local is keyed by path, so a local write needs the project's directory.
	 */
	export const locate = async (
		home: string,
		cwd: string,
		scope?: string,
	): Promise<Result<Where>> => {
		const project = await projectAt(cwd, home);
		if (!project.ok) return project;
		const named = scope === undefined ? undefined : ScopeUri.getScopeId(scope);
		const scopeId = named
			? named.ok
				? named.value
				: scope
			: project.value?.scopeId;
		const here =
			project.value && project.value.scopeId === scopeId ? project.value : null;
		if (here === null) return ok(scopeId === undefined ? {} : { scopeId });
		const localRoot = await tryCatch(() => mainCheckoutRoot(here.root));
		if (!localRoot.ok) return localRoot;
		return ok({
			...(canonical(cwd) === canonical(here.root) ? { projectDir: cwd } : {}),
			localRoot: localRoot.value,
			scopeId: here.scopeId,
		});
	};

	/**
	 * The layer a write with no `--layer` goes to: a device key's only one, global; otherwise
	 * local in a project (or with `--scope`) and global outside one.
	 */
	const defaultTarget = (entry: Key, where: Where): Target =>
		entry.namespace !== undefined &&
		(where.localRoot !== undefined || where.scopeId !== undefined)
			? "local"
			: "global";

	/** One key as `list` reads it at `view`: its value, where that comes from, and its traits. */
	const rowOf = (entry: Key, view: View, where: Where) => {
		const origin = topOrigin(entry, view);
		return {
			key: entry.key,
			...(entry.namespace ? { namespace: entry.namespace.name } : {}),
			value: redact(entry.key, valueAt(view.value, entry.path)) ?? null,
			default: origin.layer === "default",
			layer: origin.layer,
			...(origin.label === undefined ? {} : { from: origin.label }),
			hides: hidesAt(entry, view),
			readOnly: identities.has(entry.key),
			protected: isProtected(entry.key),
			description: entry.field.description ?? "",
			// Where the board's editor saves first: where `set` with no layer would write.
			target: defaultTarget(entry, where),
			...traitsOf(entry, where),
		};
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
			const row = rowOf(entry, view, where);
			rows.push(row);
			// A record's entries follow it, in its group, described by it unless they say more.
			for (const child of entriesOf(keys.value, entry, view)) {
				const own = rowOf(child, view, where);
				rows.push({
					...own,
					group: row.group,
					description: own.description || row.description,
				});
			}
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
			...traitsOf(entry.value, where),
		});
	};

	/** Set `key` in `layer` at `where`, or remove it from that layer when `input` is undefined. */
	export const set = async (
		home: string,
		where: Where,
		key: string,
		input: string | undefined,
		layer?: Target,
	): Promise<Result<ConfigChange>> => {
		const keys = await allKeys();
		if (!keys.ok) return keys;
		const entry = find(keys.value, key);
		if (!entry.ok) return entry;
		const loaded = loadConfigDocument(home);
		return loaded.ok
			? writeSetting(
					{ home, where, layer: layer ?? defaultTarget(entry.value, where) },
					loaded.value.stored,
					entry.value,
					input,
				)
			: loaded;
	};
}
