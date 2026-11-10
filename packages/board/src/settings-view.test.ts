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

	test("j/k move within the rows, enter opens the detail, and esc or `,` closes", () => {
		const start = opened();
		expect(selectedKey(start)).toBe("actor");
		expect(press(start, "k").state).toBe(start);
		const moved = press(start, "j", "j").state;
		expect(selectedKey(moved)).toBe("sync.token");
		expect(press(moved, "return").state.settings?.detail).toBe(true);
		expect(press(moved, "return", "return").state.settings?.detail).toBe(false);
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
