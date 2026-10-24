// A run's config as the board's trigger form: one input per setting the form can hold, read off
// `LoopConfig.Schema` so a field the schema gains shows up without a change here, and the form's
// values back into config overrides.
//
// The schema says what a field is (an enum, a number, a boolean, an optional) and the resolved
// config what it is set to. `LOOKS` only says how a known field reads: its label, its group, and
// the values `h/l` steps through. A field with no look still shows, under its path and an `Other`
// group (or its parent object's name), stepping through its enum, by one for a number, or on and
// off. The lenses, a list of names, get a toggle each over the lenses the project can run. A field
// the form cannot hold (free text with no options, a record) is left to the repo's
// `.kabane/loop.json` and flags: the gates, named shell commands, which the preview lists read-only.
import type { TriggerInput } from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { z } from "zod";
import { LoopConfig } from "./config";

export namespace LoopSettings {
	type Kind = "enum" | "number" | "boolean" | "string" | "other";

	type Field = {
		path: readonly string[];
		kind: Kind;
		/** The enum's values, for an enum. */
		values: readonly string[];
		/** Absent is a valid setting (the model: the user's own). */
		optional: boolean;
	};

	type Look = {
		label: string;
		group: string;
		/** The values `h/l` steps through; the configured value joins them when it is not one. */
		options?: readonly (string | number)[];
		/** What the row says for an optional field left unset. */
		none?: string;
	};

	const NONE = "none";

	const range = (from: number, to: number): number[] =>
		Array.from({ length: to - from + 1 }, (_, i) => from + i);

	const LOOKS: Readonly<Record<string, Look>> = {
		implementer: { label: "implementer", group: "Agents" },
		// Only Claude reads a model; the aliases are its own. Unset, the user's own settings decide.
		model: {
			label: "model",
			group: "Agents",
			options: ["opus", "sonnet", "haiku"],
			none: "your own",
		},
		"budget.concurrency": {
			label: "concurrent sessions",
			group: "Limits",
			options: range(1, 8),
		},
		"budget.wallMinutes": {
			label: "wall time (min)",
			group: "Limits",
			options: [15, 30, 60, 120, 240, 480],
		},
		"budget.continuations": {
			label: "continuations",
			group: "Limits",
			options: [0, 1, 2, 3, 5, 10],
		},
		"budget.spend": {
			label: "spend",
			group: "Limits",
			options: [1, 5, 10, 25, 50, 100],
		},
		stallAfter: {
			label: "stall after (attempts)",
			group: "Limits",
			options: range(1, 6),
		},
		// Unset, the lenses run on the implementer's harness.
		verifier: { label: "verifier", group: "Agents", none: "implementer" },
		worktree: { label: "own git worktree", group: "Workspace" },
	};

	// The form's sections, in this order whatever order the schema has its fields in; a group no
	// look names comes after them.
	const GROUPS = ["Agents", "Limits", "Checks", "Workspace"];

	// Lenses are a list of names; the form holds one toggle per lens it can offer, `lenses.<name>`.
	const LENS_PREFIX = "lenses.";

	// Peel the wrappers that say how a value may be absent, keeping whether it may.
	const unwrap = (
		schema: z.ZodTypeAny,
	): { inner: z.ZodTypeAny; optional: boolean } => {
		if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
		if (schema instanceof z.ZodOptional) {
			const inner = unwrap(schema.unwrap());
			return { inner: inner.inner, optional: true };
		}
		return { inner: schema, optional: false };
	};

	const kindOf = (schema: z.ZodTypeAny): Kind => {
		if (schema instanceof z.ZodEnum) return "enum";
		if (schema instanceof z.ZodNumber) return "number";
		if (schema instanceof z.ZodBoolean) return "boolean";
		if (schema instanceof z.ZodString) return "string";
		return "other";
	};

	/** Every leaf of the config schema, in its order, nested objects flattened by path. */
	const fieldsOf = (
		shape: z.ZodRawShape,
		prefix: readonly string[] = [],
	): Field[] =>
		Object.entries(shape).flatMap(([key, schema]): Field[] => {
			const { inner, optional } = unwrap(schema);
			const path = [...prefix, key];
			if (inner instanceof z.ZodObject) return fieldsOf(inner.shape, path);
			return [
				{
					path,
					kind: kindOf(inner),
					values: inner instanceof z.ZodEnum ? inner.options : [],
					optional,
				},
			];
		});

	const FIELDS = fieldsOf(LoopConfig.Schema.shape);

	const nameOf = (field: Field): string => field.path.join(".");

	const lookOf = (field: Field): Look =>
		LOOKS[nameOf(field)] ?? {
			label: nameOf(field),
			group:
				field.path.length > 1
					? `${field.path[0]?.charAt(0).toUpperCase()}${field.path[0]?.slice(1)}`
					: "Other",
		};

	const ObjectSchema = z.record(z.unknown());

	const valueAt = (config: unknown, path: readonly string[]): unknown =>
		path.reduce<unknown>((at, key) => {
			const object = ObjectSchema.safeParse(at);
			return object.success ? object.data[key] : undefined;
		}, config);

	// A number's options in order with the configured value among them; anything else keeps its
	// order with the value added at the end.
	const withValue = (
		options: readonly (string | number)[],
		value: unknown,
	): string[] => {
		const all =
			(typeof value === "string" || typeof value === "number") &&
			!options.includes(value)
				? [...options, value]
				: [...options];
		const numeric = all.every((o) => typeof o === "number");
		return (numeric ? all.sort((a, b) => Number(a) - Number(b)) : all).map(
			String,
		);
	};

	const optionsOf = (field: Field, look: Look, value: unknown): string[] => {
		const listed =
			field.kind === "enum"
				? withValue(field.values, value)
				: look.options
					? withValue(look.options, value)
					: [];
		return field.optional && listed.length > 0
			? [look.none ?? NONE, ...listed]
			: listed;
	};

	/** One field's input, or undefined when the form cannot hold it. */
	const inputOf = (
		field: Field,
		config: LoopConfig.Config,
	): TriggerInput | undefined => {
		const look = lookOf(field);
		const value = valueAt(config, field.path);
		const options = optionsOf(field, look, value);
		const common = { label: look.label, group: look.group, required: false };
		if (options.length > 0)
			return {
				...common,
				type: field.kind === "number" ? "number" : "string",
				options,
				default: value === undefined ? (look.none ?? NONE) : String(value),
			};
		return (field.kind === "number" || field.kind === "boolean") &&
			value !== undefined
			? { ...common, type: field.kind, default: value }
			: undefined;
	};

	// A lens toggle per lens on offer and per lens the config already names, on when it names it.
	const lensInputs = (
		config: LoopConfig.Config,
		offered: readonly string[],
	): [string, TriggerInput][] =>
		[...new Set([...offered, ...config.lenses])].map((name) => [
			`${LENS_PREFIX}${name}`,
			{
				type: "boolean",
				required: false,
				default: config.lenses.includes(name),
				label: `lens ${name}`,
				group: "Checks",
			},
		]);

	const groupRank = (input: TriggerInput): number => {
		const at = GROUPS.indexOf(input.group ?? "");
		return at === -1 ? GROUPS.length : at;
	};

	/**
	 * The form's inputs for a run configured as `config`, by setting path (`budget.concurrency`),
	 * each defaulting to what the config says, plus a toggle per lens in `lenses` (the ones the
	 * project can run). Grouped in GROUPS order; a setting the form cannot hold (the gates, a
	 * named command each) is left out.
	 */
	export const inputs = (
		config: LoopConfig.Config,
		lenses: readonly string[] = [],
	): Record<string, TriggerInput> => {
		const entries: [string, TriggerInput][] = [];
		for (const field of FIELDS) {
			const input = inputOf(field, config);
			if (input) entries.push([nameOf(field), input]);
		}
		entries.push(...lensInputs(config, lenses));
		// A stable sort: within a group, the schema's order.
		entries.sort(([, a], [, b]) => groupRank(a) - groupRank(b));
		return Object.fromEntries(entries);
	};

	const setAt = (
		target: Record<string, unknown>,
		path: readonly string[],
		value: unknown,
	): void => {
		const [head, ...rest] = path;
		if (head === undefined) return;
		if (rest.length === 0) {
			target[head] = value;
			return;
		}
		const existing = ObjectSchema.safeParse(target[head]);
		const child = existing.success ? existing.data : {};
		target[head] = child;
		setAt(child, rest, value);
	};

	// A form value as the config holds it: an option's text back to a number, the unset option to
	// absent (undefined, so it unsets what the repo file says too).
	const fromForm = (field: Field, value: unknown): Result<unknown> => {
		if (field.optional && value === (lookOf(field).none ?? NONE))
			return ok(undefined);
		if (field.kind !== "number" || typeof value === "number") return ok(value);
		const number = Number(value);
		return Number.isFinite(number)
			? ok(number)
			: err(new Error(`${nameOf(field)} is not a number: ${String(value)}`));
	};

	/** The form's values as config overrides, for `Loop.start` to layer over the repo file. */
	export const overrides = (
		values: Readonly<Record<string, unknown>>,
	): Result<LoopConfig.Overrides> => {
		const out: Record<string, unknown> = {};
		for (const field of FIELDS) {
			if (!(nameOf(field) in values)) continue;
			const value = fromForm(field, values[nameOf(field)]);
			if (!value.ok) return value;
			setAt(out, field.path, value.value);
		}
		// The lens toggles become the list, in the form's order; without any, the file's list stands.
		const toggles = Object.entries(values).filter(([name]) =>
			name.startsWith(LENS_PREFIX),
		);
		if (toggles.length > 0)
			out.lenses = toggles
				.filter(([, on]) => on === true)
				.map(([name]) => name.slice(LENS_PREFIX.length));
		return ok(out);
	};
}
