// Settings resolve through layers, so no setting handles where it comes from. A namespace (an
// extension's name) declares one zod schema; every layer holds a partial document of it. Lowest
// first: the schema's defaults, the user's config, the project's checked-in file, the user's
// settings for the project's scope, then the caller (flags, the board's form). Where each layer is
// stored is the host's business: it hands `port` the documents, and this merges and validates them.
//
// Objects merge key by key and anything else is replaced, so a record of gates gains a gate per
// layer while a list of lenses is whatever the highest layer that names it says. A key set to null (or undefined, from
// code) unsets what the layers below it say; it must still name a setting.
import { err, ok, type Result } from "@cabane/core";
import { z } from "zod";

export namespace Settings {
	export type Layer = "default" | "user" | "project" | "scope" | "caller";

	/** One layer's document for a namespace, and the name an error in it or a value from it gives. */
	export type Source = {
		layer: Exclude<Layer, "default">;
		/** The file path, or what else names the document: "your settings for scope X in <path>". */
		label: string;
		value: unknown;
	};

	/** Where a resolved value came from; a default has no label. */
	export type Origin = { layer: Layer; label?: string };

	/** A namespace's resolved settings and, for each leaf of it (a scalar or a list), its origin. */
	export type Resolved<T> = {
		value: T;
		origins: { path: readonly string[]; origin: Origin }[];
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

	/** The schema under its optional, default and effect wrappers: what a value of it holds. */
	export const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
		if (schema instanceof z.ZodOptional) return unwrap(schema.unwrap());
		if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
		if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
		return schema;
	};

	/**
	 * The unsets in `value` that name no setting: a key a strict object does not have, or one its
	 * record's key schema refuses. The value check never sees them, since pruning removes them.
	 */
	const unsetIssues = (
		namespace: string,
		schema: z.ZodTypeAny,
		value: unknown,
		path: readonly string[] = [],
	): string[] => {
		const inner = unwrap(schema);
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
			const field: z.ZodTypeAny | undefined = inner.shape[key];
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

	// Origins by path, a NUL between segments: a record key (a gate name) may hold a dot.
	type Origins = Map<string, Origin>;
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
			forget(origins, path);
			origins.set(keyOf(path), origin);
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
			: [{ path, origin: origins.get(keyOf(path)) ?? { layer: "default" } }];

	/**
	 * `sources`, lowest first, over the schema's defaults. Each is validated on its own first, so an
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
		let merged: unknown = {};
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
