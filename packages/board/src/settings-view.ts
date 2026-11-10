// Every setting, its value and the layer it comes from: the view `,` opens over the board. Plain
// functions over the board's state, like the other key routers, so the keys and the clicks are
// tested without a renderer.
//
// The rows are the host's (SettingsSource), read when the view opens and never at board start, and
// the view is generated from them: a namespace an extension declares appears with no code here. It
// is read-only: changing a setting is the copilot's, or `kabane config set`.
import type { BoardNav } from "./nav";
import type { SettingLayer, SettingRow } from "./ports";

export namespace SettingsView {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };

	export type Rows =
		| { type: "loading" }
		| { type: "ready"; rows: readonly SettingRow[] }
		// The host has no SettingsSource.
		| { type: "unavailable" }
		| { type: "failed"; error: string };

	export type View = {
		rows: Rows;
		// The row in hand, by its place in the ready rows.
		selected: number;
		// Whether the row in hand shows its detail line: the file, and what it hides.
		detail: boolean;
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

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

	/** The host's answer, into the open view; nothing when it closed meanwhile. */
	export const withRows = (state: State, rows: Rows): State =>
		state.settings
			? {
					...state,
					settings: {
						rows:
							rows.type === "ready"
								? { type: "ready", rows: ordered(rows.rows) }
								: rows,
						selected: 0,
						detail: false,
					},
				}
			: state;

	const count = (view: View): number =>
		view.rows.type === "ready" ? view.rows.rows.length : 0;

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

	/** The view's keys. It is modal: every other key does nothing while it is open. */
	export const reduceKey = (
		state: State,
		view: View,
		key: BoardNav.KeyInput,
	): Step => {
		if (key.name === "escape" || isKey(key))
			return { state: { ...state, settings: null }, effect: NOTHING };
		switch (key.name) {
			case "j":
			case "down":
				return select(state, view, view.selected + 1);
			case "k":
			case "up":
				return select(state, view, view.selected - 1);
			case "return":
			case "enter":
				return toggle(state, view);
			default:
				return { state, effect: NOTHING };
		}
	};

	/**
	 * A click on the `index`th row: it takes the selection, and a click on the row already in hand
	 * opens or closes its detail, as `enter` does.
	 */
	export const click = (state: State, index: number): Step => {
		const view = state.settings;
		if (!view) return { state, effect: NOTHING };
		return index === view.selected
			? toggle(state, view)
			: select(state, view, index);
	};

	/** What each layer is, said where its word first needs it. */
	const MEANING: Readonly<Record<SettingLayer, string>> = {
		default: "no file sets it",
		global: "every project on this device",
		shared: "the file in the repo",
		local: "this project and only you",
		caller: "this run only",
	};

	const plain = (value: unknown): string =>
		typeof value === "string" ? value : JSON.stringify(value);

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
