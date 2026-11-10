// The settings view through the board's own routers: `,` opens it and asks the host for rows,
// which it lists under namespace then group; its keys and clicks move and open a row's detail.
import { describe, expect, test } from "bun:test";
import { BoardNav } from "./nav";
import type { SettingRow } from "./ports";
import { SettingsView } from "./settings-view";
import { Fixtures } from "./stories/fixtures";

const board = (): BoardNav.BoardState => BoardNav.init([], { scoped: false });

const key = (name: string): BoardNav.KeyInput =>
	name.length === 1 ? { name, sequence: name } : { name };

const press = (
	state: BoardNav.BoardState,
	...names: string[]
): { state: BoardNav.BoardState; effect: BoardNav.Effect } => {
	let step = { state, effect: { type: "none" } as BoardNav.Effect };
	for (const name of names)
		step = BoardNav.reduceKey(step.state, key(name), BoardNav.ARM_MS);
	return step;
};

const opened = (
	rows: readonly SettingRow[] = Fixtures.SETTINGS,
): BoardNav.BoardState =>
	SettingsView.withRows(press(board(), ",").state, { type: "ready", rows });

const selectedKey = (state: BoardNav.BoardState): string | undefined => {
	const view = state.settings;
	return view?.rows.type === "ready"
		? view.rows.rows[view.selected]?.key
		: undefined;
};

describe("SettingsView", () => {
	test("`,` opens it loading and asks the host for rows; nothing is read before", () => {
		const { state, effect } = press(board(), ",");
		expect(effect).toEqual({ type: "loadSettings" });
		expect(state.settings).toEqual({
			rows: { type: "loading" },
			selected: 0,
			detail: false,
		});
		expect(BoardNav.keyContext(state)).toBe("settings");
	});

	test("rows sit under their namespace then group; groups and a record with entries are no rows", () => {
		const shuffled = [
			...Fixtures.SETTINGS.filter((row) => row.namespace === "loop"),
			...Fixtures.SETTINGS.filter((row) => row.namespace === undefined),
		];
		const rows = SettingsView.ordered(shuffled).map((row) => row.key);
		expect(rows).toEqual([
			"loop.implementer",
			"loop.budget.continuations",
			"loop.budget.concurrency",
			"loop.stallAfter",
			"loop.gates.test",
			"loop.lenses",
			"actor",
			"sync.enabled",
			"sync.token",
			"copilot.harness",
			"timezone",
		]);
	});

	test("a group the host names twice in one namespace lists together, in the host's order", () => {
		const [first, second, third] = ["a", "b", "c"].map((name, i) => ({
			...Fixtures.SETTINGS[0],
			key: name,
			label: name,
			group: i === 1 ? "Two" : "One",
		})) as [SettingRow, SettingRow, SettingRow];
		expect(
			SettingsView.ordered([first, second, third]).map((row) => row.key),
		).toEqual(["a", "c", "b"]);
	});

	test("j/k move within the rows, enter opens a read-only row's detail, and esc or `,` closes", () => {
		const start = opened();
		expect(selectedKey(start)).toBe("actor");
		expect(press(start, "k").state).toBe(start);
		expect(press(start, "return").state.settings?.detail).toBe(true);
		expect(press(start, "return", "return").state.settings?.detail).toBe(false);
		const moved = press(start, "j", "j").state;
		expect(selectedKey(moved)).toBe("sync.token");
		expect(press(moved, "escape").state.settings).toBeNull();
		expect(press(moved, ",").state.settings).toBeNull();
		// Modal: the board's own keys do nothing while it is open.
		expect(press(moved, "q").effect).toEqual({ type: "none" });
	});

	test("a click selects a row, and a click on the row in hand opens its detail", () => {
		const start = opened();
		const picked = BoardNav.reduceMouse(start, {
			type: "settingsRow",
			index: 2,
		}).state;
		expect(selectedKey(picked)).toBe("sync.token");
		expect(picked.settings?.detail).toBe(false);
		const again = BoardNav.reduceMouse(picked, {
			type: "settingsRow",
			index: 2,
		}).state;
		expect(again.settings?.detail).toBe(true);
	});

	test("rows that land after the view closed are dropped", () => {
		const closed = press(board(), ",", "escape").state;
		expect(
			SettingsView.withRows(closed, { type: "ready", rows: Fixtures.SETTINGS }),
		).toBe(closed);
	});

	test("a value reads as its row shows it: lists joined, records counted, unset as its look says", () => {
		const row = (key: string): SettingRow => {
			const found = Fixtures.SETTINGS.find((r) => r.key === key);
			if (!found) throw new Error(key);
			return found;
		};
		expect(SettingsView.display(row("loop.lenses"))).toBe("quality");
		expect(SettingsView.display(row("loop.gates"))).toBe("1 entry");
		expect(SettingsView.display(row("copilot.harness"))).toBe("claude");
		expect(SettingsView.display(row("sync.token"))).toBe("<set>");
		expect(SettingsView.display(row("sync.enabled"))).toBe("true");
		expect(
			SettingsView.display({ ...row("loop.implementer"), value: null }),
		).toBe("unset");
	});

	test("the detail gives the file, what the layer means, and the value it hides", () => {
		const gate = Fixtures.SETTINGS.find((r) => r.key === "loop.gates.test");
		if (!gate) throw new Error("no gate");
		expect(SettingsView.detail(gate)).toEqual([
			"loop.gates.test",
			"Named shell commands run after each finished subtask.",
			"local, this project and only you: /Users/ada/.kabane/projects/-Users-ada-acme-widget-8380ae31/loop.json",
			"hides shared, the file in the repo: bun test (/Users/ada/acme/widget/.kabane/loop.json)",
		]);
		const actor = Fixtures.SETTINGS.find((r) => r.key === "actor");
		if (!actor) throw new Error("no actor");
		expect(SettingsView.detail(actor)).toContain("read-only: kabane sets it");
	});
});

describe("SettingsView's editor", () => {
	const on = (key: string): BoardNav.BoardState => {
		const state = opened();
		const view = state.settings;
		if (view?.rows.type !== "ready") throw new Error("no rows");
		const selected = view.rows.rows.findIndex((row) => row.key === key);
		return { ...state, settings: { ...view, selected } };
	};

	const edit = (state: BoardNav.BoardState) => state.settings?.edit;

	test("a list is typed whole, its items apart by commas, and h/l leave it alone", () => {
		const lenses = Fixtures.SETTINGS.find((row) => row.key === "loop.lenses");
		if (!lenses) throw new Error("no lenses row");
		const row: SettingRow = {
			...lenses,
			value: ["functional", "quality"],
			options: ["functional", "quality", "security"],
		};
		const rows = [row];
		expect(press(opened(rows), "l").state.settings?.edit).toBeUndefined();
		const typing = press(opened(rows), "return").state;
		expect(edit(typing)?.change).toEqual({
			type: "type",
			text: "functional, quality",
		});
		expect(SettingsView.typing(row)).toBe(
			"apart by commas, each one of functional, quality, security; empty for none",
		);
		const saved = press(typing, ...", security".split(""), "return");
		expect(saved.effect).toMatchObject({
			type: "saveSetting",
			key: "loop.lenses",
			value: "functional,quality,security",
		});
		const refused = press(typing, ...",nope".split(""), "return");
		expect(refused.effect.type).toBe("none");
		expect(edit(refused.state)?.error).toBe(
			'"nope" is not one of functional, quality, security',
		);
		const cleared = press(
			typing,
			...Array.from("functional, quality", () => "backspace"),
			"return",
		);
		expect(cleared.effect).toMatchObject({ type: "saveSetting", value: "" });
	});

	test("h/l step a value as the run form does, and enter saves it where config set would", () => {
		const stepped = press(on("loop.stallAfter"), "l");
		expect(edit(stepped.state)).toEqual({
			key: "loop.stallAfter",
			layer: "local",
			change: { type: "step", value: 4 },
		});
		const saved = press(stepped.state, "return");
		expect(saved.effect).toEqual({
			type: "saveSetting",
			key: "loop.stallAfter",
			value: 4,
			layer: "local",
		});
		expect(edit(saved.state)?.saving).toBe(true);
		// Saving: the keys wait for the host's answer.
		expect(press(saved.state, "l").state).toBe(saved.state);
	});

	test("tab walks the row's own layers, and a device key has global only", () => {
		const local = press(on("loop.stallAfter"), "l").state;
		expect(edit(press(local, "tab").state)?.layer).toBe("global");
		expect(edit(press(local, "tab", "tab").state)?.layer).toBe("shared");
		const device = press(on("copilot.harness"), "l").state;
		expect(edit(device)?.layer).toBe("global");
		expect(press(device, "tab").state).toBe(device);
	});

	test("a save to shared asks a y/n first: n goes back, y saves", () => {
		const shared = press(on("loop.stallAfter"), "l", "tab", "tab").state;
		const asked = press(shared, "return");
		expect(asked.effect).toEqual({ type: "none" });
		expect(edit(asked.state)?.confirm).toBe(true);
		expect(edit(press(asked.state, "n").state)?.confirm).toBeUndefined();
		expect(press(asked.state, "y").effect).toEqual({
			type: "saveSetting",
			key: "loop.stallAfter",
			value: 4,
			layer: "shared",
		});
	});

	test("enter types a number, read with the field's bounds; a refused one writes nothing", () => {
		const typing = press(on("loop.budget.concurrency"), "return").state;
		expect(edit(typing)?.change).toEqual({ type: "type", text: "" });
		const refused = press(typing, "9", "return");
		expect(refused.effect).toEqual({ type: "none" });
		expect(edit(refused.state)?.error).toBe(
			'"9" is not a whole number from 1 to 8',
		);
		// h and l are letters while typing.
		expect(edit(press(refused.state, "l").state)?.change).toEqual({
			type: "type",
			text: "9l",
		});
		expect(press(refused.state, "backspace", "5", "return").effect).toEqual({
			type: "saveSetting",
			key: "loop.budget.concurrency",
			value: 5,
			layer: "local",
		});
	});

	test("a secret starts empty, is never echoed in an error, and a protected key asks first", () => {
		const typing = press(on("sync.token"), "return").state;
		expect(edit(typing)?.change).toEqual({ type: "type", text: "" });
		const asked = press(typing, "s", "3", "return");
		expect(asked.effect).toEqual({ type: "none" });
		expect(edit(asked.state)?.confirm).toBe(true);
		expect(press(asked.state, "y").effect).toEqual({
			type: "saveSetting",
			key: "sync.token",
			value: "s3",
			layer: "global",
		});
		const row = Fixtures.SETTINGS.find((r) => r.key === "sync.token");
		if (!row) throw new Error("no token");
		const { state } = press(
			opened([
				{ ...row, field: { ...row.field, kind: "string", minLength: 4 } },
			]),
			"return",
			"s",
			"return",
		);
		expect(edit(state)?.error).toBe(
			"the value is not text of at least 4 characters",
		);
	});

	test("x removes the key from the layer picked; a record's entry and a read-only key stay", () => {
		const unset = press(on("loop.stallAfter"), "x", "return");
		expect(unset.effect).toEqual({
			type: "saveSetting",
			key: "loop.stallAfter",
			value: { unset: true },
			layer: "local",
		});
		const entry = on("loop.gates.test");
		expect(press(entry, "x").state).toBe(entry);
		const actor = on("actor");
		expect(press(actor, "x").state).toBe(actor);
		expect(press(actor, "l").state).toBe(actor);
	});

	test("esc leaves the editor and keeps the view", () => {
		const back = press(on("loop.stallAfter"), "l", "escape").state;
		expect(back.settings).not.toBeNull();
		expect(edit(back)).toBeUndefined();
	});

	test("a save the layers no longer resolve after says so, as a warning", () => {
		expect(
			SettingsView.outcome("loop.stallAfter", {
				key: "loop.stallAfter",
				layer: "global",
				from: "/h/config.json",
				value: 6,
				unresolved: "/r/.kabane/loop.json: JSON Parse error",
				restart: "resolve",
			}),
		).toEqual({
			key: "loop.stallAfter",
			lines: [
				"saved 6 to global",
				"but settings no longer resolve: /r/.kabane/loop.json: JSON Parse error",
			],
			warn: true,
		});
	});

	test("after a save the rows are read again, the saved one in hand, saying who still decides", () => {
		const saving = press(on("loop.stallAfter"), "l", "tab", "return").state;
		const row = Fixtures.SETTINGS.find((r) => r.key === "loop.stallAfter");
		if (!row) throw new Error("no row");
		const said = SettingsView.outcome("loop.stallAfter", {
			key: "loop.stallAfter",
			layer: "global",
			from: "/h/config.json",
			value: 6,
			shadowedBy: { layer: "local", from: "/h/loop.json", value: 4 },
			restart: "start",
		});
		expect(said).toEqual({
			key: "loop.stallAfter",
			lines: [
				"saved 6 to global",
				"local still decides: 4 (/h/loop.json)",
				"it applies at the next start",
			],
			warn: true,
		});
		const reread = SettingsView.saved(
			saving,
			{ type: "ready", rows: [...Fixtures.SETTINGS].reverse() },
			said,
		);
		expect(selectedKey(reread)).toBe("loop.stallAfter");
		expect(reread.settings?.said).toEqual(said);
		expect(edit(reread)).toBeUndefined();
		expect(press(reread, "j").state.settings?.said).toBeUndefined();
	});

	test("a save the host refuses keeps the editor open with its reason", () => {
		const saving = press(on("loop.stallAfter"), "l", "return").state;
		const refused = SettingsView.refused(
			saving,
			"loop.stallAfter",
			"no project",
		);
		expect(edit(refused)).toEqual({
			key: "loop.stallAfter",
			layer: "local",
			change: { type: "step", value: 4 },
			error: "no project",
		});
	});
});
