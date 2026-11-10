// A run's config as the board's trigger form: one input per setting the form can hold, read off
// `LoopConfig.Schema` so a field the schema gains shows up without a change here, and the form's
// values back into config overrides.
//
// The schema says what a field is (an enum, a number, a boolean, an optional) and the resolved
// config what it is set to. The looks the loop declares (`loop.looks`) only say how a field reads:
// its label, its group, and the values `h/l` steps through. A field with no look still shows,
// under its path and an `Other` group (or its parent object's name), stepping through its enum, a
// bounded integer's range, by one for another number, or on and off. The lenses, a list of names,
// get a toggle each over the lenses the project can run. A field the form cannot hold (free text
// with no options, a record) is left to the settings layers (`kabane config`) and flags: the gates,
// named shell commands, which the preview lists read-only.
import type { SettingField, TriggerInput } from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { Settings } from "@cabane/extension";
import { z } from "zod";
import { LoopConfig } from "./config";
import { loop } from "./extension";

export namespace LoopSettings {
	type Look = Settings.Look;

	const NONE = "none";

	// Read at a call, never at load: the extension's declaration imports this module.
	const looks = (): Settings.Looks => loop.looks ?? {};

	// Lenses are a list of names; the form holds one toggle per lens it can offer, `lenses.<name>`.
	const LENS_PREFIX = "lenses.";

	// The form holds settings, not the groups they sit in.
	const FIELDS = Settings.fields(LoopConfig.Schema).filter(
		(field) => field.kind !== "group",
	);

	const nameOf = (field: SettingField): string => field.path.join(".");

	const lookOf = (field: SettingField): Look =>
		Settings.lookOf(looks(), field.path);

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

	// The form steps through a scalar's options; the lenses get their toggles from the caller.
	const optionsOf = (
		field: SettingField,
		look: Look,
		value: unknown,
	): string[] => {
		const options =
			field.kind === "list" ? undefined : Settings.options(field, look, {});
		const listed = options ? withValue(options, value) : [];
		return field.optional && listed.length > 0
			? [look.none ?? NONE, ...listed]
			: listed;
	};

	/** One field's input, or undefined when the form cannot hold it. */
	const inputOf = (
		field: SettingField,
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

	const groupRank = (
		groups: readonly string[],
		input: TriggerInput,
	): number => {
		const at = groups.indexOf(input.group ?? "");
		return at === -1 ? groups.length : at;
	};

	/**
	 * The form's inputs for a run configured as `config`, by setting path (`budget.concurrency`),
	 * each defaulting to what the config says, plus a toggle per lens in `lenses` (the ones the
	 * project can run). Grouped in the order the loop's looks name the groups; a setting the form cannot hold (the gates, a
	 * named command each) is left out.
	 */
	export const inputs = (
		config: LoopConfig.Config,
		lenses: readonly string[] = [],
	): Record<string, TriggerInput> => {
		// The lens toggles first: in their group, the recheck of what the lenses found follows them.
		const entries: [string, TriggerInput][] = lensInputs(config, lenses);
		for (const field of FIELDS) {
			const input = inputOf(field, config);
			if (input) entries.push([nameOf(field), input]);
		}
		// A stable sort: within a group, the schema's order.
		const groups = Settings.groupsOf(looks());
		entries.sort(([, a], [, b]) => groupRank(groups, a) - groupRank(groups, b));
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
	// absent (undefined, so it unsets what the layers below say too).
	const fromForm = (field: SettingField, value: unknown): Result<unknown> => {
		if (field.optional && value === (lookOf(field).none ?? NONE))
			return ok(undefined);
		if (field.kind !== "number" || typeof value === "number") return ok(value);
		const number = Number(value);
		return Number.isFinite(number)
			? ok(number)
			: err(new Error(`${nameOf(field)} is not a number: ${String(value)}`));
	};

	/** The form's values as the caller's layer, for `Loop.start` to put over the stored settings. */
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
		// The lens toggles become the list, in the form's order; without any, the stored list stands.
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
