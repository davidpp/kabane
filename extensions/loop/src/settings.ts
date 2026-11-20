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
import type { Result } from "@kabane/core";
import type {
	Host,
	SettingField,
	Settings,
	TriggerInput,
} from "@kabane/extension";
import type { LoopAdvice } from "./advice";
import { LoopConfig } from "./config";
import { looks } from "./extension";
import { err, ok } from "./result";

export namespace LoopSettings {
	type Look = Settings.Look;

	const NONE = "none";

	// Lenses are a list of names; the form holds one toggle per lens it can offer, `lenses.<name>`.
	const LENS_PREFIX = "lenses.";

	// The form holds settings, not the groups they sit in.
	const fields = (host: Host) =>
		host.settings
			.fields(LoopConfig.schemas(host.z).Schema)
			.filter((field) => field.kind !== "group");

	const nameOf = (field: SettingField): string => field.path.join(".");

	const defaults = (host: Host) => {
		const parsed = LoopConfig.schemas(host.z).Schema.safeParse({});
		return parsed.success ? parsed.data : {};
	};

	const lookOf = (host: Host, field: SettingField): Look =>
		host.settings.lookOf(looks, field.path);

	const objectSchema = (host: Host) =>
		host.z.record(host.z.string(), host.z.unknown());

	const valueAt = (
		host: Host,
		config: unknown,
		path: readonly string[],
	): unknown =>
		path.reduce<unknown>((at, key) => {
			const object = objectSchema(host).safeParse(at);
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

	// The model steps through every tier the config knows, those `loop.tiers` adds included, which
	// the look's own options cannot read.
	const MODEL = "model";

	// The form steps through a scalar's options; the lenses get their toggles from the caller.
	const optionsOf = (
		host: Host,
		field: SettingField,
		look: Look,
		config: LoopConfig.Config,
	): string[] => {
		const value = valueAt(host, config, field.path);
		const options =
			field.kind === "list"
				? undefined
				: nameOf(field) === MODEL
					? LoopConfig.tierNames(config)
					: host.settings.options(field, look, {});
		const listed = options ? withValue(options, value) : [];
		return field.optional && listed.length > 0
			? [look.none ?? NONE, ...listed]
			: listed;
	};

	/** One field's input, or undefined when the form cannot hold it. */
	const inputOf = (
		host: Host,
		field: SettingField,
		config: LoopConfig.Config,
	): TriggerInput | undefined => {
		const look = lookOf(host, field);
		const value = valueAt(host, config, field.path);
		const options = optionsOf(host, field, look, config);
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
		host: Host,
		config: LoopConfig.Config,
		lenses: readonly string[] = [],
		advice: readonly LoopAdvice.Recommendation[] = [],
	): Record<string, TriggerInput> => {
		// The lens toggles first: in their group, the recheck of what the lenses found follows them.
		const entries: [string, TriggerInput][] = lensInputs(config, lenses);
		for (const field of fields(host)) {
			const recommendation = advice.find((r) => r.path === nameOf(field));
			const input = inputOf(host, field, config);
			if (input && recommendation) {
				const previous = valueAt(host, config, field.path);
				// The port resolves without origins, so a value equal to the schema's default is taken
				// as unset: naming it "your setting" would credit the human with a default.
				const yours =
					previous !== undefined &&
					previous !== recommendation.value &&
					previous !== valueAt(host, defaults(host), field.path);
				input.default =
					input.options && typeof recommendation.value === "number"
						? String(recommendation.value)
						: recommendation.value;
				input.hint = `advised: ${recommendation.reason}${yours ? ` (your setting: ${String(previous)})` : ""}`;
			}
			if (input) entries.push([nameOf(field), input]);
		}
		// A stable sort: within a group, the schema's order.
		const groups = host.settings.groupsOf(looks);
		entries.sort(([, a], [, b]) => groupRank(groups, a) - groupRank(groups, b));
		return Object.fromEntries(entries);
	};

	const setAt = (
		host: Host,
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
		const existing = objectSchema(host).safeParse(target[head]);
		const child = existing.success ? existing.data : {};
		target[head] = child;
		setAt(host, child, rest, value);
	};

	// A form value as the config holds it: an option's text back to a number, the unset option to
	// absent (undefined, so it unsets what the layers below say too).
	const fromForm = (
		host: Host,
		field: SettingField,
		value: unknown,
	): Result<unknown> => {
		if (field.optional && value === (lookOf(host, field).none ?? NONE))
			return ok(undefined);
		if (field.kind !== "number" || typeof value === "number") return ok(value);
		const number = Number(value);
		return Number.isFinite(number)
			? ok(number)
			: err(new Error(`${nameOf(field)} is not a number: ${String(value)}`));
	};

	/** The form's values as the caller's layer, for `Loop.start` to put over the stored settings. */
	export const overrides = (
		host: Host,
		values: Readonly<Record<string, unknown>>,
		advice: readonly LoopAdvice.Recommendation[] = [],
	): Result<LoopConfig.Overrides> => {
		const out: Record<string, unknown> = {};
		for (const recommendation of advice)
			setAt(host, out, recommendation.path.split("."), recommendation.value);
		for (const field of fields(host)) {
			if (!(nameOf(field) in values)) continue;
			const value = fromForm(host, field, values[nameOf(field)]);
			if (!value.ok) return value;
			setAt(host, out, field.path, value.value);
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
