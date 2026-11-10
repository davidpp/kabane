// Settings resolve through layers, so no setting handles where it comes from. A namespace (an
// extension's name) declares one zod schema; every layer holds a partial document of it. Lowest
// first: the schema's defaults; global, for every project on this device; shared, the project's
// checked-in settings for everyone who clones it; local, the project's settings for you only on
// this device; then the caller (flags, the board's form). Where each layer is stored is the host's
// business: it hands `port` the documents, and this merges and validates them.
//
// The schema's defaults are the lowest layer. Objects merge key by key and anything else is
// replaced, so a record of gates gains a gate per layer, defaulted ones included, while a list of
// lenses is whatever the highest layer that names it says. A key set to null (or undefined, from
// code) unsets what the layers below it say; it must still name a setting.
import type {
	SettingField,
	SettingKind,
	SettingValue,
} from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { z } from "zod";

export namespace Settings {
	export type Layer = "default" | "global" | "shared" | "local" | "caller";

	/** One layer's document for a namespace, and the name an error in it or a value from it gives. */
	export type Source = {
		layer: Exclude<Layer, "default">;
		/** The file path, or what else names the document: "scopes.<id> in <path>". */
		label: string;
		value: unknown;
	};

	/** Where a resolved value came from; a default has no label. */
	export type Origin = { layer: Layer; label?: string };

	/**
	 * A namespace's resolved settings and, for each leaf of it (a scalar or a list), its origin and
	 * what the stored layers under it set there, lowest first: the values it hides.
	 */
	export type Resolved<T> = {
		value: T;
		origins: {
			path: readonly string[];
			origin: Origin;
			hides: readonly Source[];
		}[];
	};

	/** A settings namespace a host knows: its name and the schema of what a human writes in it. */
	export type Namespace = { name: string; schema: z.ZodTypeAny };

	/**
	 * What an extension resolves its settings through (`Extension.Ctx.settings`): `namespace` in
	 * the project checked out at `projectDir`, with `overrides` as the caller's layer.
	 */
	export type Port = <S extends z.ZodTypeAny>(
		namespace: string,
		schema: S,
		at: { projectDir: string; overrides?: Readonly<Record<string, unknown>> },
	) => Promise<Result<z.output<S>>>;

	/** What the caller's layer is called in an error. */
	export const CALLER = "the given overrides";

	const isObject = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);

	const unsets = (value: unknown): boolean =>
		value === null || value === undefined;

	/** A layer's document without its unsets: what it says on its own. */
	const prune = (value: unknown): unknown =>
		isObject(value)
			? Object.fromEntries(
					Object.entries(value)
						.filter(([, inner]) => !unsets(inner))
						.map(([key, inner]) => [key, prune(inner)]),
				)
			: value;

	/** One line per issue, `path: message`; an unknown key is its own line. */
	const issues = (namespace: string, error: z.ZodError): string =>
		error.issues
			.flatMap((issue) =>
				issue.code === "unrecognized_keys"
					? issue.keys.map(
							(key) =>
								`${[...issue.path, key].join(".")}: not a ${namespace} setting`,
						)
					: [`${issue.path.join(".") || "(settings)"}: ${issue.message}`],
			)
			.map((line) => `\n  ${line}`)
			.join("");

	type Peeled = { inner: z.ZodTypeAny; optional: boolean; default?: unknown };

	// The outermost default is the one a parse fills in.
	const peel = (schema: z.ZodTypeAny): Peeled => {
		if (schema instanceof z.ZodOptional)
			return { ...peel(schema.unwrap()), optional: true };
		if (schema instanceof z.ZodDefault)
			return {
				...peel(schema.removeDefault()),
				default: schema._def.defaultValue(),
			};
		if (schema instanceof z.ZodEffects) return peel(schema.innerType());
		return { inner: schema, optional: false };
	};

	/** The schema under its optional, default and effect wrappers: what a value of it holds. */
	export const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny =>
		peel(schema).inner;

	const numberOf = (schema: z.ZodNumber): SettingKind => {
		const kind: Extract<SettingKind, { kind: "number" }> = {
			kind: "number",
			integer: false,
		};
		for (const check of schema._def.checks) {
			if (check.kind === "int") kind.integer = true;
			else if (check.kind === "min") {
				if (check.inclusive) kind.minimum = check.value;
				else kind.exclusiveMinimum = check.value;
			} else if (check.kind === "max") {
				if (check.inclusive) kind.maximum = check.value;
				else kind.exclusiveMaximum = check.value;
			}
		}
		return kind;
	};

	const stringOf = (
		schema: z.ZodString,
	): Extract<SettingKind, { kind: "string" }> => {
		const kind: Extract<SettingKind, { kind: "string" }> = { kind: "string" };
		for (const check of schema._def.checks) {
			if (check.kind === "min") kind.minLength = check.value;
			else if (check.kind === "max") kind.maxLength = check.value;
			else if (check.kind === "regex") kind.pattern = check.regex.source;
		}
		return kind;
	};

	const kindOf = (schema: z.ZodTypeAny): SettingKind => {
		if (schema instanceof z.ZodEnum)
			return { kind: "enum", values: schema.options };
		if (schema instanceof z.ZodNumber) return numberOf(schema);
		if (schema instanceof z.ZodBoolean) return { kind: "boolean" };
		if (schema instanceof z.ZodString) return stringOf(schema);
		if (schema instanceof z.ZodArray)
			return { kind: "list", item: valueOf(schema.element) };
		if (schema instanceof z.ZodRecord) {
			const key = unwrap(schema.keySchema);
			const pattern =
				key instanceof z.ZodString ? stringOf(key).pattern : undefined;
			return {
				kind: "record",
				...(pattern === undefined ? {} : { keyPattern: pattern }),
				value: valueOf(schema.valueSchema),
			};
		}
		if (schema instanceof z.ZodObject) return { kind: "group" };
		return { kind: "other" };
	};

	const valueOf = (schema: z.ZodTypeAny): SettingValue => {
		const { inner, optional, default: fallback } = peel(schema);
		return {
			optional,
			...(fallback === undefined ? {} : { default: fallback }),
			...(schema.description === undefined
				? {}
				: { description: schema.description }),
			...kindOf(inner),
		};
	};

	/** What `schema` declares of a setting at `path`: its kind, bounds, default and description. */
	export const field = (
		schema: z.ZodTypeAny,
		path: readonly string[] = [],
	): SettingField => ({ ...valueOf(schema), path });

	/** A setting and the schema it was read from, for a host that also parses values with it. */
	export type Entry = { field: SettingField; schema: z.ZodTypeAny };

	/**
	 * Every setting of a namespace's schema, in its order: a group (an object) and then the
	 * settings in it. A record's entries are not walked: its field describes them.
	 */
	export const entries = (
		schema: z.ZodTypeAny,
		path: readonly string[] = [],
	): Entry[] => {
		const inner = unwrap(schema);
		if (!(inner instanceof z.ZodObject)) return [];
		const shape: z.ZodRawShape = inner.shape;
		return Object.entries(shape).flatMap(([name, child]) => {
			const at = [...path, name];
			return [
				{ field: field(child, at), schema: child },
				...entries(child, at),
			];
		});
	};

	/** The fields of every setting `schema` declares, as `entries` walks them. */
	export const fields = (schema: z.ZodTypeAny): SettingField[] =>
		entries(schema).map((entry) => entry.field);

	// Its issues are the value check's to report; here only the value it leaves matters.
	const QUIET: z.RefinementCtx = { addIssue: () => undefined, path: [] };

	/**
	 * `schema` under its wrappers, and `value` as its preprocessing leaves it: a preprocess is how a
	 * schema normalises what it still accepts (the loop drops a retired key), so an unset of such a
	 * key is checked after it, as a value of it is.
	 */
	const unwrapWith = (
		schema: z.ZodTypeAny,
		value: unknown,
	): { inner: z.ZodTypeAny; value: unknown } => {
		if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
			return unwrapWith(schema._def.innerType, value);
		if (schema instanceof z.ZodEffects) {
			const { effect } = schema._def;
			return unwrapWith(
				schema.innerType(),
				effect.type === "preprocess" ? effect.transform(value, QUIET) : value,
			);
		}
		return { inner: schema, value };
	};

	/**
	 * The unsets in `value` that name no setting: a key a strict object does not have (inherited
	 * names such as `constructor` included), or one its record's key schema refuses. The value
	 * check never sees them, since pruning removes them.
	 */
	const unsetIssues = (
		namespace: string,
		schema: z.ZodTypeAny,
		given: unknown,
		path: readonly string[] = [],
	): string[] => {
		const { inner, value } = unwrapWith(schema, given);
		if (!isObject(value)) return [];
		return Object.entries(value).flatMap(([key, child]) => {
			const at = [...path, key].join(".");
			if (inner instanceof z.ZodRecord) {
				const named = inner.keySchema.safeParse(key);
				if (!named.success)
					return unsets(child)
						? named.error.issues.map(
								(issue: z.ZodIssue) => `${at}: ${issue.message}`,
							)
						: [];
				return unsetIssues(namespace, inner.valueSchema, child, [...path, key]);
			}
			if (!(inner instanceof z.ZodObject)) return [];
			const shape: Record<string, z.ZodTypeAny> = inner.shape;
			const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
			if (field !== undefined)
				return unsetIssues(namespace, field, child, [...path, key]);
			return unsets(child) && inner._def.unknownKeys === "strict"
				? [`${at}: not a ${namespace} setting`]
				: [];
		});
	};

	/** One layer on its own, so an error names the layer it is in. */
	export const validate = (
		namespace: string,
		schema: z.ZodTypeAny,
		source: Source,
	): Result<void> => {
		const invalid = `Invalid ${namespace} settings in ${source.label}:`;
		if (!isObject(source.value))
			return err(new Error(`${invalid} expected a JSON object`));
		const parsed = schema.safeParse(prune(source.value));
		const found =
			(parsed.success ? "" : issues(namespace, parsed.error)) +
			unsetIssues(namespace, schema, source.value)
				.map((line) => `\n  ${line}`)
				.join("");
		return found === "" ? ok(undefined) : err(new Error(`${invalid}${found}`));
	};

	// Origins by path, a NUL between segments: a record key (a gate name) may hold a dot. Beside
	// each, the values of the layers under it that it replaced; a default is no layer's, so none.
	type Origins = Map<string, { origin: Origin; hides: Source[] }>;
	const keyOf = (path: readonly string[]): string => path.join("\0");

	const forget = (origins: Origins, path: readonly string[]): void => {
		const at = keyOf(path);
		for (const key of origins.keys())
			if (key === at || key.startsWith(`${at}\0`)) origins.delete(key);
	};

	const merge = (
		base: unknown,
		over: unknown,
		origin: Origin,
		path: readonly string[],
		origins: Origins,
	): unknown => {
		if (!isObject(over)) {
			const below = origins.get(keyOf(path));
			const hides = below === undefined ? [] : [...below.hides];
			if (
				below !== undefined &&
				below.origin.layer !== "default" &&
				below.origin.label !== undefined &&
				!isObject(base)
			)
				hides.push({
					layer: below.origin.layer,
					label: below.origin.label,
					value: base,
				});
			forget(origins, path);
			origins.set(keyOf(path), { origin, hides });
			return over;
		}
		if (!isObject(base)) forget(origins, path);
		const merged: Record<string, unknown> = isObject(base) ? { ...base } : {};
		for (const [key, value] of Object.entries(over)) {
			const at = [...path, key];
			if (unsets(value)) {
				delete merged[key];
				forget(origins, at);
			} else merged[key] = merge(merged[key], value, origin, at, origins);
		}
		return merged;
	};

	// Every leaf of the resolved value with the origin of the layer that set it, or its default.
	const leaves = (
		value: unknown,
		path: readonly string[],
		origins: Origins,
	): Resolved<unknown>["origins"] =>
		isObject(value) && Object.keys(value).length > 0
			? Object.entries(value).flatMap(([key, inner]) =>
					leaves(inner, [...path, key], origins),
				)
			: [
					{
						path,
						...(origins.get(keyOf(path)) ?? {
							origin: { layer: "default" },
							hides: [],
						}),
					},
				];

	/**
	 * `sources`, lowest first, over the schema's defaults as the lowest layer. Each is validated on its own first, so an
	 * error names it; then the merge, whose error names every layer in it.
	 */
	export const resolve = <S extends z.ZodTypeAny>(
		namespace: string,
		schema: S,
		sources: readonly Source[],
	): Result<Resolved<z.output<S>>> => {
		for (const source of sources) {
			const alone = validate(namespace, schema, source);
			if (!alone.ok) return alone;
		}
		const origins: Origins = new Map();
		// A schema that needs keys has no defaults to put under the layers: the device config, one
		// whole document, which its own parse defaults.
		const defaults = schema.safeParse({});
		let merged = merge(
			{},
			defaults.success ? defaults.data : {},
			{ layer: "default" },
			[],
			origins,
		);
		for (const { layer, label, value } of sources)
			merged = merge(merged, value, { layer, label }, [], origins);
		const parsed = schema.safeParse(merged);
		if (!parsed.success)
			return err(
				new Error(
					`Invalid ${namespace} settings in ${sources.map((s) => s.label).join(" over ")}:${issues(namespace, parsed.error)}`,
				),
			);
		const value: z.output<S> = parsed.data;
		return ok({ value, origins: leaves(value, [], origins) });
	};

	/**
	 * A port over the host's layers: `sources` gives a namespace's documents for a project, lowest
	 * first, and the port puts the caller's overrides over them.
	 */
	export const port =
		(
			sources: (
				namespace: string,
				projectDir: string,
			) => Promise<Result<Source[]>>,
		): Port =>
		async (namespace, schema, { projectDir, overrides }) => {
			const stored = await sources(namespace, projectDir);
			if (!stored.ok) return stored;
			const caller: Source[] = overrides
				? [{ layer: "caller", label: CALLER, value: overrides }]
				: [];
			const resolved = resolve(namespace, schema, [...stored.value, ...caller]);
			return resolved.ok ? ok(resolved.value.value) : resolved;
		};
}
