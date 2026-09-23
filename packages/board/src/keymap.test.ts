// The key registry against the reducers it describes. Keymap is display copy and nav.ts is the binding
// authority, so the one way a hint goes stale is a key rebound or removed in nav.ts while its hint
// stays: the drift guard below fails the gate then, context by context. The rest pins what the
// registry promises the views: whole hints at forty columns, `? help` kept, a key listed once.
import { describe, expect, test } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { CopilotLog } from "./copilot-log";
import type { BoardData } from "./data";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";

const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JAKE-1",
	title: "A task",
	kind: "issue",
	state: "in_progress",
	priority: "normal",
	provenance: { source: "human", discoveredAt: new Date().toISOString() },
	needsReview: false,
	tags: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...over,
});

const sections = (rows: BoardData.BoardRow[]): BoardData.BoardSection[] => [
	{
		state: "in_progress",
		label: TASK_STATE_DISPLAY.in_progress.label,
		rows,
	},
];

const copilot = (
	over: Partial<BoardNav.CopilotState> = {},
): BoardNav.CopilotState => ({
	text: "",
	paletteAt: 0,
	history: [],
	historyAt: 0,
	turn: "idle",
	hasLog: false,
	shortcuts: [],
	actor: null,
	permission: null,
	...over,
});

// Three rows, the middle one a collapsed parent, selected: j and k both have somewhere to go, and
// every row key has a row to act on.
const ROWS = sections([
	{ task: task({ id: "a", shortId: "JAKE-1" }), children: [] },
	{
		task: task({ id: "p", shortId: "JAKE-2" }),
		children: [task({ id: "c", shortId: "JAKE-3", parentTaskId: "p" })],
	},
	{ task: task({ id: "b", shortId: "JAKE-4" }), children: [] },
]);

const state = (
	over: Partial<BoardNav.BoardState> = {},
): BoardNav.BoardState => ({
	sections: ROWS,
	selectedId: "p",
	expanded: new Set<string>(),
	kind: "all",
	status: "open",
	scoped: false,
	view: { type: "board" },
	search: { mode: "off" },
	dispatch: null,
	help: false,
	focus: "board",
	sidebar: { visible: true, selected: 1, itemCount: 3 },
	marked: new Set<string>(),
	copilot: copilot(),
	undo: [],
	...over,
});

const TRIGGERS = [1, 2, 3].map((n) => ({
	id: `t${n}`,
	label: `trigger ${n}`,
	inputs: {},
	satisfiable: true,
}));

const SHORTCUTS = [
	{ name: "triage", template: "Triage.", hint: "sort" },
	{ name: "trim", template: "Trim.", hint: "cut" },
];

// Each nav-routed context and states where it is live. A key passes when it does something in at
// least one of them: some keys only act from one side (`k` needs a row above, `1` a tab that is not
// the first).
const FIXTURES: Partial<Record<Keymap.ContextId, BoardNav.BoardState[]>> = {
	board: [
		state(),
		state({ expanded: new Set(["p"]) }),
		state({
			marked: new Set(["a"]),
			copilot: copilot({ hasLog: true }),
		}),
	],
	searchResults: [state({ search: { mode: "committed", query: "task" } })],
	search: [state({ search: { mode: "typing", query: "ab" } })],
	detail: [
		state({ view: { type: "detail", taskId: "p" } }),
		state({ view: { type: "detail", taskId: "p", tab: "comments" } }),
	],
	transcript: [
		state({
			view: { type: "events", cardId: CopilotLog.CARD_ID, fromView: "board" },
			copilot: copilot({ turn: "running", hasLog: true }),
		}),
	],
	sidebar: [state({ focus: "sidebar" })],
	copilot: [
		state({ focus: "copilot", copilot: copilot({ history: ["earlier"] }) }),
	],
	palette: [
		state({
			focus: "copilot",
			copilot: copilot({ text: "/tr", shortcuts: SHORTCUTS }),
		}),
		state({
			focus: "copilot",
			copilot: copilot({ text: "/tr", shortcuts: SHORTCUTS, paletteAt: 1 }),
		}),
	],
	dispatch: [0, 1].map((selected) =>
		state({
			dispatch: { taskId: "p", triggers: TRIGGERS, selected, loading: false },
		}),
	),
	help: [state({ help: true })],
};

const keyInput = (name: string): BoardNav.KeyInput => {
	if (name.startsWith("ctrl+")) return { name: name.slice(5), ctrl: true };
	if (name.startsWith("shift+")) return { name: name.slice(6), shift: true };
	return name.length === 1 ? { name, sequence: name } : { name };
};

// "Does something": the reducer changed the state or asked app.tsx for an effect.
const acts = (s: BoardNav.BoardState, key: BoardNav.KeyInput): boolean => {
	const { state: next, effect } = BoardNav.reduceKey(s, key);
	return effect.type !== "none" || !Bun.deepEquals(next, s);
};

const SHEET_CONTEXTS = (
	Object.keys(Keymap.CONTEXTS) as Keymap.ContextId[]
).filter((id) => Keymap.CONTEXTS[id].sheet && id !== "searchResults");

describe("the drift guard: every key the registry lists does something in its context", () => {
	for (const [id, fixtures] of Object.entries(FIXTURES) as [
		Keymap.ContextId,
		BoardNav.BoardState[],
	][]) {
		test(id, () => {
			// The fixtures really are this context (the sheet's own keys overlay whatever is under it).
			if (id !== "help")
				for (const fixture of fixtures)
					expect(BoardNav.keyContext(fixture)).toBe(id);
			for (const binding of Keymap.CONTEXTS[id].bindings) {
				if (binding.routed) continue;
				expect({
					id,
					hint: binding.key,
					keys: binding.keys.length > 0,
				}).toEqual({ id, hint: binding.key, keys: true });
				for (const name of binding.keys)
					expect({
						id,
						key: name,
						acts: fixtures.some((f) => acts(f, keyInput(name))),
					}).toEqual({ id, key: name, acts: true });
			}
		});
	}

	test("the everywhere keys do something in every context the sheet opens from", () => {
		for (const id of SHEET_CONTEXTS)
			for (const binding of Keymap.EVERYWHERE)
				for (const name of binding.keys)
					expect({
						id,
						key: name,
						acts: (FIXTURES[id] ?? []).some((f) => acts(f, keyInput(name))),
					}).toEqual({ id, key: name, acts: true });
	});

	test("every context with keys of its own has a fixture, or its keys belong to another handler", () => {
		for (const id of Object.keys(Keymap.CONTEXTS) as Keymap.ContextId[]) {
			const unrouted = Keymap.CONTEXTS[id].bindings.filter((b) => !b.routed);
			if (unrouted.length > 0)
				expect({ id, fixture: id in FIXTURES }).toEqual({ id, fixture: true });
		}
	});

	test("setup's keys are its own handler's, and say so", () => {
		for (const id of ["setupWelcome", "setupForm", "setupDone"] as const)
			for (const binding of Keymap.CONTEXTS[id].bindings)
				expect(binding.routed).toBe("setup");
	});
});

describe("Keymap.footer", () => {
	test("where the sheet opens, the footer ends in `? help`; where `?` is a character, it does not", () => {
		expect(Keymap.footer("board").at(-1)).toEqual({ key: "?", label: "help" });
		expect(Keymap.footer("transcript").at(-1)).toEqual({
			key: "?",
			label: "help",
		});
		expect(Keymap.footer("copilot").map((h) => h.key)).not.toContain("?");
		expect(Keymap.footer("search").map((h) => h.key)).not.toContain("?");
	});

	test("an unavailable key is left out of the footer", () => {
		expect(Keymap.footer("board").map((h) => h.key)).toEqual(["/", "?"]);
		expect(
			Keymap.footer("board", { selection: true, linked: true }).map(
				(h) => h.key,
			),
		).toEqual(["O", "/", "d", "v", "m", "y", "?"]);
		expect(Keymap.footer("transcript").map((h) => h.key)).not.toContain("x");
		expect(
			Keymap.footer("transcript", { stoppable: true }).map((h) => h.key),
		).toContain("x");
		expect(Keymap.footer("setupWorking")).toEqual([]);
	});

	test("at forty columns every context keeps whole hints, and `? help` where the sheet opens", () => {
		const everything: Keymap.Situation = {
			selection: true,
			linked: true,
			events: true,
			transcript: true,
			stoppable: true,
			clearable: true,
			history: true,
			ready: true,
			scrollable: true,
			harnesses: true,
		};
		for (const id of Object.keys(Keymap.CONTEXTS) as Keymap.ContextId[]) {
			const all = Keymap.footer(id, everything);
			const fitted = Keymap.fitHints(all, 40);
			expect(Keymap.hintLine(fitted).length).toBeLessThanOrEqual(40);
			for (const hint of fitted) expect(all).toContainEqual(hint);
			if (Keymap.CONTEXTS[id].sheet)
				expect({ id, last: fitted.at(-1)?.key }).toEqual({ id, last: "?" });
		}
	});
});

describe("Keymap.fitHints", () => {
	const hints = [
		{ key: "a", label: "one" },
		{ key: "b", label: "two" },
		{ key: "?", label: "help" },
	];

	test("keeps what fits, drops whole hints from the end, and keeps `? help` last", () => {
		expect(Keymap.fitHints(hints, 40)).toEqual(hints);
		expect(Keymap.fitHints(hints, 16)).toEqual([hints[0], hints[2]]);
		expect(Keymap.fitHints(hints, 6)).toEqual([hints[2]]);
		expect(Keymap.fitHints(hints, 3)).toEqual([]);
	});

	test("with no `? help` at the end, the tail simply drops", () => {
		expect(Keymap.fitHints(hints.slice(0, 2), 6)).toEqual([hints[0]]);
	});
});

describe("Keymap.sheet", () => {
	test("the view's keys under its name, then the everywhere group, each binding once", () => {
		for (const id of SHEET_CONTEXTS) {
			const groups = Keymap.sheet(id);
			expect(groups.map((g) => g.title)).toEqual([
				Keymap.CONTEXTS[id].name,
				"everywhere",
			]);
			const rows = groups.flatMap((g) =>
				g.rows.map((r) => `${r.key} ${r.label}`),
			);
			expect({ id, dupes: rows.length - new Set(rows).size }).toEqual({
				id,
				dupes: 0,
			});
		}
	});

	test("a key that does nothing right now stays in the sheet, marked unavailable", () => {
		const [own] = Keymap.sheet("board", { selection: false });
		const done = own?.rows.find((r) => r.key === "d");
		expect(done).toEqual({ key: "d", label: "done", available: false });
		const search = own?.rows.find((r) => r.key === "/");
		expect(search?.available).toBe(true);
	});
});

describe("BoardNav.keyContext", () => {
	test("a modal first, then the pane with focus, then the view", () => {
		const base = state();
		expect(BoardNav.keyContext(base)).toBe("board");
		expect(
			BoardNav.keyContext({
				...base,
				dispatch: { taskId: "p", triggers: [], selected: 0, loading: true },
				focus: "copilot",
			}),
		).toBe("dispatch");
		expect(BoardNav.keyContext({ ...base, focus: "copilot" })).toBe("copilot");
		expect(
			BoardNav.keyContext({
				...base,
				focus: "sidebar",
				sidebar: { ...base.sidebar, visible: false },
			}),
		).toBe("board");
		expect(
			BoardNav.keyContext({
				...base,
				view: { type: "detail", taskId: "p" },
				search: { mode: "committed", query: "x" },
			}),
		).toBe("detail");
	});

	test("the sheet over a committed search lists the board's keys", () => {
		const searched = state({ search: { mode: "committed", query: "task" } });
		expect(BoardNav.keyContext(searched)).toBe("searchResults");
		expect(BoardNav.sheetContext(searched)).toBe("board");
	});
});

describe("BoardNav.keySituation", () => {
	const facts = { linked: new Set(["p"]), events: false };

	test("facts from the state in hand and from the host's links", () => {
		const board = BoardNav.keySituation(state(), facts);
		expect(board).toMatchObject({
			selection: true,
			linked: true,
			clearable: false,
			stoppable: false,
			ready: false,
		});
		expect(
			BoardNav.keySituation(state({ selectedId: "a" }), facts).linked,
		).toBe(false);
		expect(
			BoardNav.keySituation(state({ marked: new Set(["a"]) }), facts).clearable,
		).toBe(true);
		expect(
			BoardNav.keySituation(state({ scoped: true }), facts).clearable,
		).toBe(true);
	});

	test("the detail view's task is the one in hand, whatever row the board had selected", () => {
		const detail = state({
			selectedId: "a",
			view: { type: "detail", taskId: "p" },
		});
		expect(BoardNav.keySituation(detail, facts).linked).toBe(true);
	});

	test("x stops only the copilot's own running turn; the picker is ready once it has triggers", () => {
		const transcript = FIXTURES.transcript?.[0];
		expect(
			transcript && BoardNav.keySituation(transcript, facts).stoppable,
		).toBe(true);
		const picker = FIXTURES.dispatch?.[0];
		expect(picker && BoardNav.keySituation(picker, facts).ready).toBe(true);
		const copilotFixture = FIXTURES.copilot?.[0];
		expect(
			copilotFixture && BoardNav.keySituation(copilotFixture, facts).history,
		).toBe(true);
	});
});
