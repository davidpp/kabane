// Every setting, its value and the layer it comes from: the view `,` opens over the board, and the
// editor of the row in hand. Plain functions over the board's state, like the other key routers, so
// the keys and the clicks are tested without a renderer.
//
// The rows are the host's (SettingsSource), read when the view opens and never at board start, and
// the view is generated from them: a namespace an extension declares appears with no code here. A
// change is saved through the same port, to the layer the editor picks, and the rows are read again.
import { FormField } from "./form-field";
import type { BoardNav } from "./nav";
import type {
	SettingChange,
	SettingLayer,
	SettingRow,
	SettingWrite,
} from "./ports";
import { TriggerForm } from "./trigger-form";

export namespace SettingsView {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	export type Rows =
		| { type: "loading" }
		// `entries`: the rows that are a record's entries, whose adding and removing is the CLI's.
		| {
				type: "ready";
				rows: readonly SettingRow[];
				entries?: readonly string[];
		  }
		// The host has no SettingsSource.
		| { type: "unavailable" }
		| { type: "failed"; error: string };

	export type View = {
		rows: Rows;
		// The row in hand, by its place in the ready rows.
		selected: number;
		// Whether the row in hand shows its detail line: the file, and what it hides.
		detail: boolean;
		// The change being made to the row in hand, from its first key to its save.
		edit?: Edit;
		// What the last save said, under the row it saved, until the next key.
		said?: Said;
	};

	/**
	 * A change to one setting: a value stepped through its choices (`h/l`), one typed (`enter` on a
	 * string or a number), or the key removed (`x`); and the layer it goes to (`tab`). `confirm`: the
	 * y/n a save to the repo, or to a protected key, asks first. `error`: why the value was refused,
	 * by the editor or by the host.
	 */
	export type Edit = {
		key: string;
		layer: SettingLayer;
		change:
			| { type: "step"; value: unknown }
			| { type: "type"; text: string }
			| { type: "unset" };
		confirm?: boolean;
		saving?: boolean;
		error?: string;
	};

	/** What a save said, a line each; `warn` when the value written is not the one in effect. */
	export type Said = { key: string; lines: readonly string[]; warn: boolean };

	const NOTHING: BoardNav.Effect = { type: "none" };

	const plain = (value: unknown): string =>
		typeof value === "string" ? value : JSON.stringify(value);

	/** What the device's own keys sit under: they belong to no extension. */
	const DEVICE = "kabane";

	/** `,`: the view opens loading, and the host is asked for its rows. */
	export const open = (state: State): Step => ({
		state: {
			...state,
			settings: { rows: { type: "loading" }, selected: 0, detail: false },
		},
		effect: { type: "loadSettings" },
	});

	export const namespaceOf = (row: SettingRow): string =>
		row.namespace ?? DEVICE;

	/**
	 * The rows the view lists, in its order: under their namespace, then their group, each in the
	 * order the host first names it, and the host's order within a group. A group of settings is
	 * not a row of its own, and neither is a record with entries: its settings, and its entries, are.
	 */
	export const ordered = (rows: readonly SettingRow[]): SettingRow[] => {
		const shown = rows.filter(
			(row) =>
				row.field.kind !== "group" &&
				!(
					row.field.kind === "record" &&
					rows.some((other) => other.key.startsWith(`${row.key}.`))
				),
		);
		const places = new Map<string, number>();
		const place = (name: string): number => {
			const known = places.get(name);
			if (known !== undefined) return known;
			places.set(name, places.size);
			return places.size - 1;
		};
		const ranked = shown.map((row, index) => ({
			row,
			index,
			namespace: place(`n:${namespaceOf(row)}`),
			group: place(`g:${namespaceOf(row)}\0${row.group}`),
		}));
		return ranked
			.sort(
				(a, b) =>
					a.namespace - b.namespace || a.group - b.group || a.index - b.index,
			)
			.map(({ row }) => row);
	};

	/** The keys of the rows that are a record's entries. */
	const entriesOf = (rows: readonly SettingRow[]): string[] => {
		const records = rows
			.filter((row) => row.field.kind === "record")
			.map((row) => `${row.key}.`);
		return rows
			.filter((row) => records.some((record) => row.key.startsWith(record)))
			.map((row) => row.key);
	};

	const ready = (rows: Rows): Rows =>
		rows.type === "ready"
			? {
					type: "ready",
					rows: ordered(rows.rows),
					entries: entriesOf(rows.rows),
				}
			: rows;

	/** The host's answer, into the open view; nothing when it closed meanwhile. */
	export const withRows = (state: State, rows: Rows): State =>
		state.settings
			? {
					...state,
					settings: { rows: ready(rows), selected: 0, detail: false },
				}
			: state;

	/**
	 * The rows read again after a save, the saved one still in hand and what the save said under it;
	 * nothing when the view closed meanwhile.
	 */
	export const saved = (state: State, rows: Rows, said: Said): State => {
		if (!state.settings) return state;
		const next = ready(rows);
		const at =
			next.type === "ready"
				? next.rows.findIndex((row) => row.key === said.key)
				: -1;
		return {
			...state,
			settings: {
				rows: next,
				selected: at < 0 ? state.settings.selected : at,
				detail: false,
				said,
			},
		};
	};

	/** The host refused a save: the editor stays open on the change, with the host's reason. */
	export const refused = (state: State, key: string, error: string): State => {
		const edit = state.settings?.edit;
		if (!state.settings || edit?.key !== key) return state;
		const { confirm: _confirm, saving: _saving, ...rest } = edit;
		return {
			...state,
			settings: { ...state.settings, edit: { ...rest, error } },
		};
	};

	const count = (view: View): number =>
		view.rows.type === "ready" ? view.rows.rows.length : 0;

	/** The row in hand, when the rows are read. */
	const inHand = (view: View): SettingRow | undefined =>
		view.rows.type === "ready" ? view.rows.rows[view.selected] : undefined;

	const isEntry = (view: View, row: SettingRow): boolean =>
		view.rows.type === "ready" && (view.rows.entries ?? []).includes(row.key);

	/** The choices `h/l` step a row through: its looked-up steps, or an enum's values. */
	const stepsOf = (row: SettingRow): TriggerForm.Steps => ({
		type: row.field.kind,
		options:
			row.options ?? (row.field.kind === "enum" ? row.field.values : undefined),
	});

	/** `h/l` move the row's value: an enum, a boolean, or a value with looked-up steps. */
	const steps = (row: SettingRow): boolean =>
		!row.readOnly &&
		(row.field.kind === "boolean" || (stepsOf(row).options?.length ?? 0) > 0);

	/** `enter` types the row's value: a string or a number. */
	const types = (row: SettingRow): boolean =>
		!row.readOnly &&
		(row.field.kind === "string" || row.field.kind === "number");

	/** The editor can remove the row's key from a layer: not a record's entry, which the CLI adds and removes. */
	const unsets = (view: View, row: SettingRow): boolean =>
		!row.readOnly && (steps(row) || types(row)) && !isEntry(view, row);

	/** The field `FormField.read` reads a typed value with, its bounds the setting's own. */
	const typedField = (row: SettingRow): FormField.Typed => {
		const base = {
			key: row.key,
			title: row.label,
			required: !row.field.optional,
		};
		const { field } = row;
		if (field.kind === "number")
			return {
				...base,
				type: "number",
				integer: field.integer,
				...(field.minimum === undefined ? {} : { minimum: field.minimum }),
				...(field.maximum === undefined ? {} : { maximum: field.maximum }),
			};
		return {
			...base,
			type: "text",
			...(field.kind === "string" && field.minLength !== undefined
				? { minLength: field.minLength }
				: {}),
			...(field.kind === "string" && field.maxLength !== undefined
				? { maxLength: field.maxLength }
				: {}),
			...(field.kind === "string" && field.pattern !== undefined
				? { pattern: field.pattern }
				: {}),
		};
	};

	/** Where a save goes first: where `kabane config set` with no `--layer` would write. */
	const firstLayer = (row: SettingRow): SettingLayer =>
		row.layers.includes(row.target) ? row.target : (row.layers[0] ?? "global");

	const current = (row: SettingRow): unknown => row.value ?? row.field.default;

	const withView = (state: State, view: View): Step => ({
		state: { ...state, settings: view },
		effect: NOTHING,
	});

	const startEdit = (
		state: State,
		view: View,
		row: SettingRow,
		change: Edit["change"],
	): Step => {
		const { said: _said, ...rest } = view;
		return withView(state, {
			...rest,
			detail: true,
			edit: { key: row.key, layer: firstLayer(row), change },
		});
	};

	/** A single printable character: what typing adds to a typed value. */
	const printable = (key: BoardNav.KeyInput): string | undefined => {
		if (key.ctrl || key.meta || key.sequence?.length !== 1) return undefined;
		const code = key.sequence.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f ? key.sequence : undefined;
	};

	const select = (state: State, view: View, index: number): Step => {
		const next = Math.max(0, Math.min(count(view) - 1, index));
		return next === view.selected
			? { state, effect: NOTHING }
			: {
					state: { ...state, settings: { ...view, selected: next } },
					effect: NOTHING,
				};
	};

	const toggle = (state: State, view: View): Step =>
		count(view) === 0
			? { state, effect: NOTHING }
			: {
					state: { ...state, settings: { ...view, detail: !view.detail } },
					effect: NOTHING,
				};

	/** `,`, which opens the view from wherever the board's everywhere keys work, and closes it. */
	export const isKey = (key: BoardNav.KeyInput): boolean =>
		!key.ctrl && !key.meta && (key.name === "," || key.sequence === ",");

	/** `l`/`right` one step on, `h`/`left` one back; undefined for any other key. */
	const stepBy = (key: BoardNav.KeyInput): 1 | -1 | undefined =>
		key.name === "l" || key.name === "right"
			? 1
			: key.name === "h" || key.name === "left"
				? -1
				: undefined;

	const isHelpKey = (key: BoardNav.KeyInput): boolean =>
		!key.ctrl && !key.meta && (key.name === "?" || key.sequence === "?");

	/**
	 * `enter`: a string or a number is typed, from its value (a secret write-only, from nothing); a
	 * row `h/l` step opens on its value; any other row opens or closes its detail.
	 */
	const enter = (
		state: State,
		view: View,
		row: SettingRow | undefined,
	): Step => {
		if (row && types(row))
			return startEdit(state, view, row, {
				type: "type",
				text:
					row.secret || row.value === null || row.value === undefined
						? ""
						: plain(row.value),
			});
		if (row && steps(row))
			return startEdit(state, view, row, { type: "step", value: current(row) });
		return toggle(state, view);
	};

	/** The view's keys. It is modal: every other key does nothing while it is open. */
	export const reduceKey = (
		state: State,
		view: View,
		key: BoardNav.KeyInput,
	): Step => {
		const row = inHand(view);
		if (view.edit && row?.key === view.edit.key)
			return reduceEditKey(state, view, row, view.edit, key);
		if (key.name === "escape" || isKey(key))
			return { state: { ...state, settings: null }, effect: NOTHING };
		if (isHelpKey(key))
			return { state: { ...state, help: true }, effect: NOTHING };
		// What the last save said stays until the next key.
		const { said: _said, ...quiet } = view;
		const by = stepBy(key);
		if (by !== undefined)
			return row && steps(row)
				? startEdit(state, quiet, row, {
						type: "step",
						value: TriggerForm.step(stepsOf(row), current(row), by),
					})
				: { state, effect: NOTHING };
		switch (key.name) {
			case "j":
			case "down":
				return select(state, quiet, view.selected + 1);
			case "k":
			case "up":
				return select(state, quiet, view.selected - 1);
			case "return":
			case "enter":
				return enter(state, quiet, row);
			case "x":
				return row && unsets(view, row)
					? startEdit(state, quiet, row, { type: "unset" })
					: { state, effect: NOTHING };
			default:
				return view.said ? withView(state, quiet) : { state, effect: NOTHING };
		}
	};

	/** What a save asks a y/n for, a line each; none when it asks nothing. */
	export const asks = (row: SettingRow, edit: Edit): string[] => [
		...(edit.layer === "shared"
			? ["shared writes a file into the repo, for everyone who clones it."]
			: []),
		...(row.protected
			? [`${row.label} is protected: the copilot leaves it to you.`]
			: []),
	];

	/** The value the editor would save, or why it would not. */
	const valueOf = (
		row: SettingRow,
		edit: Edit,
	): { ok: true; value: SettingWrite } | { ok: false; error: string } => {
		const { change } = edit;
		if (change.type === "unset") return { ok: true, value: { unset: true } };
		if (change.type === "type") {
			const read = FormField.read(typedField(row), change.text);
			if (read.ok) return { ok: true, value: read.value };
			const given = row.secret ? "the value" : `"${change.text.trim()}"`;
			return { ok: false, error: `${given} ${read.error.message}` };
		}
		const { value } = change;
		return typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
			? { ok: true, value }
			: { ok: false, error: "pick a value with h/l" };
	};

	const save = (
		state: State,
		view: View,
		row: SettingRow,
		edit: Edit,
	): Step => {
		const value = valueOf(row, edit);
		if (!value.ok)
			return withView(state, {
				...view,
				edit: { ...edit, error: value.error },
			});
		if (!edit.confirm && asks(row, edit).length > 0)
			return withView(state, { ...view, edit: { ...edit, confirm: true } });
		const { error: _error, ...rest } = edit;
		return {
			state: {
				...state,
				settings: { ...view, edit: { ...rest, saving: true } },
			},
			effect: {
				type: "saveSetting",
				key: row.key,
				value: value.value,
				layer: edit.layer,
			},
		};
	};

	/** The y/n before a save: `y` saves, `n` or `esc` go back to the editor. */
	const reduceConfirmKey = (
		state: State,
		view: View,
		row: SettingRow,
		edit: Edit,
		key: BoardNav.KeyInput,
	): Step => {
		if (key.name === "y") return save(state, view, row, edit);
		if (key.name !== "n" && key.name !== "escape")
			return { state, effect: NOTHING };
		const { confirm: _confirm, ...rest } = edit;
		return withView(state, { ...view, edit: rest });
	};

	/** The next layer of the row's own, or the one before with ⇧tab. */
	const nextLayer = (
		row: SettingRow,
		edit: Edit,
		key: BoardNav.KeyInput,
	): SettingLayer | undefined => {
		const at = row.layers.indexOf(edit.layer);
		const by = key.shift ? -1 : 1;
		const layer = row.layers[(at + by + row.layers.length) % row.layers.length];
		return layer === edit.layer ? undefined : layer;
	};

	/** What a key does to the change itself: a typed character or its deletion, or a step. */
	const changed = (
		row: SettingRow,
		change: Edit["change"],
		key: BoardNav.KeyInput,
	): Edit["change"] | undefined => {
		if (change.type === "type") {
			if (key.name === "backspace")
				return { type: "type", text: change.text.slice(0, -1) };
			const char = printable(key);
			return char === undefined
				? undefined
				: { type: "type", text: change.text + char };
		}
		const by = stepBy(key);
		return change.type === "step" && by !== undefined
			? {
					type: "step",
					value: TriggerForm.step(stepsOf(row), change.value, by),
				}
			: undefined;
	};

	/** The editor's keys: `tab` the layer, `enter` save, `esc` leave it, and the rest the value's. */
	const reduceEditKey = (
		state: State,
		view: View,
		row: SettingRow,
		edit: Edit,
		key: BoardNav.KeyInput,
	): Step => {
		if (edit.saving) return { state, effect: NOTHING };
		if (edit.confirm) return reduceConfirmKey(state, view, row, edit, key);
		const { error: _error, ...clean } = edit;
		const editing = (next: Edit): Step =>
			withView(state, { ...view, edit: next });
		if (key.name === "escape") {
			const { edit: _edit, ...rest } = view;
			return withView(state, rest);
		}
		if (key.name === "return" || key.name === "enter")
			return save(state, view, row, edit);
		if (key.name === "tab") {
			const layer = nextLayer(row, edit, key);
			return layer === undefined
				? { state, effect: NOTHING }
				: editing({ ...clean, layer });
		}
		const change = changed(row, edit.change, key);
		return change === undefined
			? { state, effect: NOTHING }
			: editing({ ...clean, change });
	};

	/**
	 * A click on the `index`th row: it takes the selection, and a click on the row already in hand
	 * opens or closes its detail, as `enter` does on a row it cannot edit. A click elsewhere leaves
	 * an open editor for the row clicked.
	 */
	export const click = (state: State, index: number): Step => {
		const view = state.settings;
		if (!view) return { state, effect: NOTHING };
		if (view.edit) {
			if (index === view.selected) return { state, effect: NOTHING };
			const { edit: _edit, ...rest } = view;
			return select(state, rest, index);
		}
		return index === view.selected
			? toggle(state, view)
			: select(state, view, index);
	};

	/** What the keys and the footer go by: the row in hand, and what its editor is doing. */
	export const situation = (
		view: View,
	): {
		settings: boolean;
		settingEditable: boolean;
		settingSteps: boolean;
		settingUnsets: boolean;
		settingEditing: boolean;
		settingTyping: boolean;
		settingLayers: boolean;
		settingConfirming: boolean;
	} => {
		const row = inHand(view);
		const edit =
			view.edit && row?.key === view.edit.key ? view.edit : undefined;
		return {
			settings: count(view) > 0,
			settingEditable: row !== undefined && (steps(row) || types(row)),
			settingSteps:
				row !== undefined &&
				steps(row) &&
				edit?.change.type !== "type" &&
				edit?.change.type !== "unset",
			settingUnsets: row !== undefined && unsets(view, row),
			settingEditing: edit !== undefined && edit.confirm !== true,
			settingTyping: edit?.change.type === "type",
			settingLayers: (row?.layers.length ?? 0) > 1,
			settingConfirming: edit?.confirm === true,
		};
	};

	/** What each layer is, said where its word first needs it. */
	const MEANING: Readonly<Record<SettingLayer, string>> = {
		default: "no file sets it",
		global: "every project on this device",
		shared: "the file in the repo",
		local: "this project and only you",
		caller: "this run only",
	};

	/** What a layer a save can go to means, said by the editor's picker. */
	export const TARGET_MEANING: Readonly<Record<SettingLayer, string>> = {
		default: "no file sets it",
		global: "every project on this device",
		shared: "this project, everyone who clones it; written to the repo",
		local: "this project, only you, this device",
		caller: "this run only",
	};

	/** What a save said: where it went, and when what decides is not what it wrote. */
	export const outcome = (key: string, change: SettingChange): Said => {
		const lines = [
			change.unset
				? `removed from ${change.layer}`
				: `saved ${plain(change.value)} to ${change.layer}`,
		];
		if (change.shadowedBy)
			lines.push(
				`${change.shadowedBy.layer} still decides: ${plain(change.shadowedBy.value)} (${change.shadowedBy.from})`,
			);
		if (change.fallsBackTo)
			lines.push(
				`${change.fallsBackTo.layer} decides now: ${plain(change.fallsBackTo.value)}`,
			);
		if (change.unresolved)
			lines.push(`but settings no longer resolve: ${change.unresolved}`);
		if (change.restart === "start") lines.push("it applies at the next start");
		return {
			key,
			lines,
			warn: change.shadowedBy !== undefined || change.unresolved !== undefined,
		};
	};

	/** A value as a row shows it: a list joined, a record by its entries, unset as its look says. */
	export const display = (
		row: Pick<SettingRow, "value" | "none" | "field">,
	): string => {
		const { value } = row;
		if (value === null || value === undefined) return row.none ?? "unset";
		if (row.field.kind === "record" && typeof value === "object") {
			const entries = Object.keys(value).length;
			return entries === 0
				? "none"
				: `${entries} ${entries === 1 ? "entry" : "entries"}`;
		}
		if (Array.isArray(value))
			return value.length === 0 ? "none" : value.map(plain).join(", ");
		return plain(value);
	};

	/** What the row's detail line says, a line each. */
	export const detail = (row: SettingRow): string[] => {
		const lines = [row.key];
		if (row.description) lines.push(row.description);
		lines.push(
			`${row.layer}, ${MEANING[row.layer]}${row.from === undefined ? "" : `: ${row.from}`}`,
		);
		// The nearest layer it hides first: the one that would decide without it.
		for (const held of [...row.hides].reverse())
			lines.push(
				`hides ${held.layer}, ${MEANING[held.layer]}: ${plain(held.value)} (${held.from})`,
			);
		if (row.readOnly) lines.push("read-only: kabane sets it");
		if (row.protected) lines.push("protected: the copilot leaves it to you");
		if (row.restart === "start" && !row.readOnly)
			lines.push("a change applies after a restart");
		return lines;
	};
}
