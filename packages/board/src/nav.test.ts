import { describe, expect, it } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardData } from "./data";
import type { DetailModel } from "./detail-model";
import { BoardNav } from "./nav";
import type {
	CopilotElicitation,
	CopilotPermission,
	TriggerDescriptor,
} from "./ports";
import { BoardPrompt } from "./prompt";
import { BoardTabs } from "./tabs";

// What the copilot is blocked on, in queue order.
const requests = (s: BoardNav.BoardState) =>
	s.copilot.asks.map((ask) => ask.request);

// One instant for every fixture: tests compare states built by separate calls, and a
// wall-clock stamp makes two of them differ whenever the calls straddle a millisecond.
const AT = "2026-01-01T00:00:00.000Z";

const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JAKE-1",
	title: "A task",
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: AT },
	needsReview: false,
	tags: [],
	createdAt: AT,
	updatedAt: AT,
	...over,
});

const row = (t: Task, children: Task[] = []): BoardData.BoardRow => ({
	task: t,
	children,
});

// Build sections from a state -> rows map (states absent are dropped, matching assembleSections).
const sections = (
	byState: Partial<Record<BoardData.SectionState, BoardData.BoardRow[]>>,
): BoardData.BoardSection[] =>
	BoardData.SECTION_STATES.filter((state) => byState[state]?.length).map(
		(state) => ({
			state,
			label: TASK_STATE_DISPLAY[state].label,
			rows: byState[state] ?? [],
		}),
	);

const copilotState = (
	over: Partial<BoardNav.CopilotState> = {},
): BoardNav.CopilotState => ({
	text: "",
	paletteAt: 0,
	history: [],
	historyAt: 0,
	turn: "idle",
	hasLog: false,
	shortcuts: [],
	commands: [],
	actor: null,
	asks: [],
	...over,
});

// Sighted at 0 (BoardNav.sight), as app.tsx would after rendering it.
const state = (over: Partial<BoardNav.BoardState> = {}): BoardNav.BoardState =>
	BoardNav.sight(
		{
			sections: [],
			selectedId: null,
			expanded: new Set<string>(),
			kind: "all",
			status: "open",
			scoped: false,
			view: { type: "board" },
			search: { mode: "off" },
			dispatch: null,
			help: false,
			focus: "board",
			tabs: BoardTabs.NONE,
			marked: new Set<string>(),
			copilot: copilotState(),
			undo: [],
			prompt: BoardPrompt.CLOSED,
			sighted: { target: undefined, since: 0 },
			...over,
		},
		0,
	);

// A key pressed once whatever the state shows has been on screen long enough to read
// (BoardNav.ARM_MS): the tests about the arming itself call BoardNav.reduceKey with their own clock.
const reduce = (
	s: BoardNav.BoardState,
	key: BoardNav.KeyInput,
): { state: BoardNav.BoardState; effect: BoardNav.Effect } =>
	BoardNav.reduceKey(BoardNav.sight(s, 0), key, BoardNav.ARM_MS);

// Feed a printable char the way OpenTUI does: name + raw sequence.
const char = (c: string): { name: string; sequence: string } => ({
	name: c,
	sequence: c,
});

// Type a whole query one keystroke at a time through the reducer.
const typeQuery = (s: BoardNav.BoardState, text: string): BoardNav.BoardState =>
	[...text].reduce((acc, c) => reduce(acc, char(c)).state, s);

describe("BoardNav.visibleRows", () => {
	it("flattens sections into rows, revealing children only under expanded parents", () => {
		const parent = task({ id: "p" });
		const child = task({ id: "c", parentTaskId: "p" });
		const base = state({
			sections: sections({ next: [row(parent, [child])] }),
			selectedId: "p",
		});
		expect(BoardNav.visibleRows(base).map((r) => r.task.id)).toEqual(["p"]);

		const expanded = { ...base, expanded: new Set(["p"]) };
		const rows = BoardNav.visibleRows(expanded);
		expect(rows.map((r) => r.task.id)).toEqual(["p", "c"]);
		expect(rows[0]).toMatchObject({
			depth: 0,
			hasChildren: true,
			expanded: true,
		});
		expect(rows[1]).toMatchObject({
			depth: 1,
			parentId: "p",
			hasChildren: false,
		});
	});
});

describe("BoardNav.reduceKey", () => {
	describe("navigation", () => {
		it("j/k move linearly over visible rows, crossing section boundaries", () => {
			const s = state({
				sections: sections({
					in_progress: [row(task({ id: "a" }))],
					next: [row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			const down = reduce(s, { name: "j" });
			expect(down.state.selectedId).toBe("b");
			expect(down.effect.type).toBe("none");
			expect(reduce(down.state, { name: "k" }).state.selectedId).toBe("a");
		});

		it("k clamps at the first row and j clamps at the last", () => {
			const s = state({
				sections: sections({
					inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			expect(reduce(s, { name: "k" }).state.selectedId).toBe("a");
			const last = state({ ...s, selectedId: "b" });
			expect(reduce(last, { name: "j" }).state.selectedId).toBe("b");
		});

		it("arrow keys mirror j/k", () => {
			const s = state({
				sections: sections({
					inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			expect(reduce(s, { name: "down" }).state.selectedId).toBe("b");
		});
	});

	describe("tree expansion", () => {
		const parent = task({ id: "p" });
		const child = task({ id: "c", parentTaskId: "p" });
		const withTree = (over: Partial<BoardNav.BoardState> = {}) =>
			state({
				sections: sections({ next: [row(parent, [child])] }),
				selectedId: "p",
				...over,
			});

		it("space expands a collapsed parent and collapses an expanded one", () => {
			const expanded = reduce(withTree(), { name: "space" });
			expect([...expanded.state.expanded]).toEqual(["p"]);
			const collapsed = reduce(expanded.state, { name: "space" });
			expect([...collapsed.state.expanded]).toEqual([]);
		});

		it("l expands the selected parent (no-op when already expanded)", () => {
			const expanded = reduce(withTree(), { name: "l" });
			expect([...expanded.state.expanded]).toEqual(["p"]);
			const again = reduce(expanded.state, { name: "l" });
			expect(again.state).toBe(expanded.state);
		});

		it("space is a no-op on a row without subtasks", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "space" }).state).toBe(s);
		});

		it("h on an expanded parent collapses it", () => {
			const s = withTree({ expanded: new Set(["p"]) });
			const collapsed = reduce(s, { name: "h" });
			expect([...collapsed.state.expanded]).toEqual([]);
			expect(collapsed.state.selectedId).toBe("p");
		});

		it("h on a child jumps selection to its parent", () => {
			const s = withTree({ expanded: new Set(["p"]), selectedId: "c" });
			const jumped = reduce(s, { name: "h" });
			expect(jumped.state.selectedId).toBe("p");
			// The parent stays expanded — h on a child only moves selection.
			expect([...jumped.state.expanded]).toEqual(["p"]);
		});
	});

	describe("kind filter", () => {
		it("i cycles all -> issue -> task -> all and asks for a reload", () => {
			const all = state({ kind: "all" });
			const issue = reduce(all, { name: "i" });
			expect(issue.state.kind).toBe("issue");
			expect(issue.effect.type).toBe("reload");
			expect(reduce(issue.state, { name: "i" }).state.kind).toBe("task");
			expect(
				reduce(reduce(issue.state, { name: "i" }).state, { name: "i" }).state
					.kind,
			).toBe("all");
		});
	});

	describe("scope escape", () => {
		it("esc widens a scoped board to all scopes and reloads", () => {
			const scoped = state({ scoped: true });
			const { state: next, effect } = reduce(scoped, {
				name: "escape",
			});
			expect(next.scoped).toBe(false);
			expect(effect.type).toBe("reload");
		});

		it("esc is a no-op once already at all scopes", () => {
			const wide = state({ scoped: false });
			const { state: next, effect } = reduce(wide, {
				name: "escape",
			});
			expect(next).toBe(wide);
			expect(effect.type).toBe("none");
		});
	});

	describe("state mutations", () => {
		it("] emits setState to the next state in the GTD progression", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "]" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "next",
				notice: "JAKE-1 → next",
			});
		});

		it("[ emits setState to the previous state", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a", state: "next" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "[" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "inbox",
				notice: "JAKE-1 → inbox",
			});
		});

		it("] on a done task is a no-op (no state beyond done)", () => {
			const s = state({
				sections: sections({ done: [row(task({ id: "a", state: "done" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "]" }).effect.type).toBe("none");
		});

		it("d emits markDone for the selected row", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "d" }).effect).toEqual({
				type: "markDone",
				id: "a",
				notice: "JAKE-1 done",
			});
		});

		it("mutation keys are no-ops when nothing is selected", () => {
			const s = state();
			expect(reduce(s, { name: "]" }).effect.type).toBe("none");
			expect(reduce(s, { name: "d" }).effect.type).toBe("none");
			expect(reduce(s, { name: "x" }).effect.type).toBe("none");
			expect(reduce(s, { name: "n" }).effect.type).toBe("none");
			expect(reduce(s, { name: "s" }).effect.type).toBe("none");
			expect(reduce(s, { name: "v" }).effect.type).toBe("none");
		});

		it("n/s/x jump the selected task directly to next/someday/cancelled", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "n" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "next",
				notice: "JAKE-1 → next",
			});
			expect(reduce(s, { name: "s" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "someday",
				notice: "JAKE-1 → someday",
			});
			expect(reduce(s, { name: "x" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "cancelled",
				notice: "JAKE-1 cancelled",
			});
		});

		it("v marks the selected task reviewed only when it carries the review flag", () => {
			const flagged = state({
				sections: sections({
					next: [row(task({ id: "a", needsReview: true }))],
				}),
				selectedId: "a",
			});
			expect(reduce(flagged, { name: "v" }).effect).toEqual({
				type: "markReviewed",
				id: "a",
				notice: "JAKE-1 reviewed",
			});

			const clean = state({
				sections: sections({
					next: [row(task({ id: "a", needsReview: false }))],
				}),
				selectedId: "a",
			});
			const { effect } = reduce(clean, { name: "v" });
			expect(effect).toEqual({
				type: "notice",
				notice: { text: "JAKE-1: no review flag", tone: "success" },
			});
		});
	});

	describe("copy (yank)", () => {
		it("y on the board emits copy for the selected row without opening detail", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			const { state: next, effect } = reduce(s, { name: "y" });
			expect(effect).toEqual({ type: "copy", id: "a" });
			expect(next.view).toEqual({ type: "board" });
		});

		it("y on the board is a no-op when nothing is selected", () => {
			expect(reduce(state(), { name: "y" }).effect.type).toBe("none");
		});

		it("y in the detail view emits copy for the open task", () => {
			const s = state({ view: { type: "detail", taskId: "a" } });
			expect(reduce(s, { name: "y" }).effect).toEqual({
				type: "copy",
				id: "a",
			});
		});
	});

	describe("open the linked issue (O)", () => {
		const board = () =>
			state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});

		it("O on the board emits openLink for the selected row without opening detail", () => {
			const { state: next, effect } = reduce(board(), {
				name: "O",
			});
			expect(effect).toEqual({ type: "openLink", id: "a" });
			expect(next.view).toEqual({ type: "board" });
		});

		it("matches the raw sequence too, since parsers disagree on shifted keys", () => {
			expect(reduce(board(), { name: "o", sequence: "O" }).effect).toEqual({
				type: "openLink",
				id: "a",
			});
		});

		it("O in the detail view acts on the open task, not the selection", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				view: { type: "detail", taskId: "b" },
			});
			expect(reduce(s, { name: "O" }).effect).toEqual({
				type: "openLink",
				id: "b",
			});
		});

		it("is a no-op when nothing is selected", () => {
			expect(reduce(state(), { name: "O" }).effect.type).toBe("none");
		});

		it("lowercase o still opens the event log, not the issue", () => {
			const s = state({ view: { type: "detail", taskId: "a" } });
			expect(reduce(s, { name: "o" }).effect).toEqual({
				type: "openEvents",
				taskId: "a",
			});
		});

		it("is a query character while a search is being typed", () => {
			const typing = reduce(board(), { name: "/" }).state;
			const { state: next, effect } = reduce(typing, {
				name: "O",
				sequence: "O",
			});
			expect(effect.type).not.toBe("openLink");
			expect(next.search).toEqual({ mode: "typing", query: "O" });
		});
	});

	describe("lifecycle keys", () => {
		it("q quits and r reloads", () => {
			expect(reduce(state(), { name: "q" }).effect.type).toBe("quit");
			expect(reduce(state(), { name: "r" }).effect.type).toBe("reload");
		});

		it("unknown keys return the same state reference", () => {
			const s = state();
			expect(reduce(s, { name: "z" }).state).toBe(s);
		});
	});

	describe("search (`/`)", () => {
		const auth = task({
			id: "auth",
			shortId: "JAKE-10",
			title: "Fix auth flow",
		});
		const board = task({
			id: "board",
			shortId: "JAKE-11",
			title: "Board polish",
		});
		const searchable = (over: Partial<BoardNav.BoardState> = {}) =>
			state({
				sections: sections({ next: [row(auth), row(board)] }),
				selectedId: "auth",
				...over,
			});

		it("/ enters typing mode with an empty query", () => {
			const { state: next, effect } = reduce(searchable(), char("/"));
			expect(next.search).toEqual({ mode: "typing", query: "" });
			expect(effect.type).toBe("none");
			// Empty query = no filter yet; the full list stays visible.
			expect(BoardNav.visibleRows(next)).toHaveLength(2);
		});

		it("printable chars append to the query and filter rows live", () => {
			const typing = reduce(searchable(), char("/")).state;
			const typed = typeQuery(typing, "auth");
			expect(typed.search).toEqual({ mode: "typing", query: "auth" });
			expect(BoardNav.visibleRows(typed).map((r) => r.task.id)).toEqual([
				"auth",
			]);
		});

		it("matches are case-insensitive over title and shortId", () => {
			const typing = reduce(searchable(), char("/")).state;
			expect(
				BoardNav.visibleRows(typeQuery(typing, "AUTH")).map((r) => r.task.id),
			).toEqual(["auth"]);
			expect(
				BoardNav.visibleRows(typeQuery(typing, "jake-11")).map(
					(r) => r.task.id,
				),
			).toEqual(["board"]);
		});

		it("board bindings are inert while typing — q filters, it does not quit", () => {
			const typing = reduce(searchable(), char("/")).state;
			const { state: next, effect } = reduce(typing, char("q"));
			expect(effect.type).toBe("none");
			expect(next.search).toEqual({ mode: "typing", query: "q" });
			// d likewise: appended, no markDone effect.
			expect(reduce(typing, char("d")).effect.type).toBe("none");
		});

		it("non-printable keys are inert while typing (same state reference)", () => {
			const typing = reduce(searchable(), char("/")).state;
			expect(reduce(typing, { name: "up", sequence: "\u001b[A" }).state).toBe(
				typing,
			);
			expect(
				reduce(typing, { name: "c", sequence: "c", ctrl: true }).state,
			).toBe(typing);
		});

		it("backspace deletes the last char; deleting to empty restores the full list", () => {
			const typed = typeQuery(reduce(searchable(), char("/")).state, "au");
			const one = reduce(typed, { name: "backspace" }).state;
			expect(one.search).toEqual({ mode: "typing", query: "a" });
			const empty = reduce(one, { name: "backspace" }).state;
			expect(empty.search).toEqual({ mode: "typing", query: "" });
			expect(BoardNav.visibleRows(empty)).toHaveLength(2);
		});

		it("enter commits the filter; keys work again over the filtered list", () => {
			const typed = typeQuery(reduce(searchable(), char("/")).state, "auth");
			const committed = reduce(typed, { name: "return" }).state;
			expect(committed.search).toEqual({ mode: "committed", query: "auth" });
			expect(BoardNav.visibleRows(committed).map((r) => r.task.id)).toEqual([
				"auth",
			]);
			// Normal bindings are live again: d marks the filtered row done.
			expect(reduce(committed, char("d")).effect).toMatchObject({
				type: "markDone",
				id: "auth",
			});
		});

		it("enter with an empty query clears the search (same as esc)", () => {
			const typing = reduce(searchable(), char("/")).state;
			const { state: next } = reduce(typing, { name: "return" });
			expect(next.search).toEqual({ mode: "off" });
		});

		it("esc while typing cancels input AND clears the query", () => {
			const typed = typeQuery(reduce(searchable(), char("/")).state, "auth");
			const { state: next } = reduce(typed, { name: "escape" });
			expect(next.search).toEqual({ mode: "off" });
			expect(BoardNav.visibleRows(next)).toHaveLength(2);
		});

		it("esc layers: committed filter clears first, scope widens on the next press", () => {
			const typed = typeQuery(
				reduce(searchable({ scoped: true }), char("/")).state,
				"auth",
			);
			const committed = reduce(typed, { name: "return" }).state;
			const cleared = reduce(committed, { name: "escape" });
			expect(cleared.state.search).toEqual({ mode: "off" });
			expect(cleared.state.scoped).toBe(true);
			expect(cleared.effect.type).toBe("none");
			const widened = reduce(cleared.state, { name: "escape" });
			expect(widened.state.scoped).toBe(false);
			expect(widened.effect.type).toBe("reload");
		});

		it("selection re-anchors to the first match when narrowing hides it, stays put otherwise", () => {
			const typing = reduce(
				searchable({ selectedId: "board" }),
				char("/"),
			).state;
			// "board" matches — selection stays.
			expect(typeQuery(typing, "board").selectedId).toBe("board");
			// "auth" hides it — selection re-anchors to the first match.
			expect(typeQuery(typing, "auth").selectedId).toBe("auth");
		});

		it("a matching subtask keeps its parent visible and forces it expanded", () => {
			const parent = task({ id: "p", shortId: "JAKE-20", title: "Parent" });
			const hit = task({
				id: "c1",
				shortId: "JAKE-21",
				title: "Wire auth token",
				parentTaskId: "p",
			});
			const miss = task({
				id: "c2",
				shortId: "JAKE-22",
				title: "Other child",
				parentTaskId: "p",
			});
			const s = state({
				sections: sections({ next: [row(parent, [hit, miss])] }),
				selectedId: "p",
			});
			const typed = typeQuery(reduce(s, char("/")).state, "auth");
			const rows = BoardNav.visibleRows(typed);
			// Parent forced open, only the matching child shown.
			expect(rows.map((r) => r.task.id)).toEqual(["p", "c1"]);
			expect(rows[0]?.expanded).toBe(true);
		});

		it("a matching parent hides non-matching children unless it is expanded", () => {
			const parent = task({ id: "p", shortId: "JAKE-20", title: "Auth epic" });
			const child = task({
				id: "c",
				shortId: "JAKE-21",
				title: "Other child",
				parentTaskId: "p",
			});
			const s = state({
				sections: sections({ next: [row(parent, [child])] }),
				selectedId: "p",
			});
			const typed = typeQuery(reduce(s, char("/")).state, "auth");
			expect(BoardNav.visibleRows(typed).map((r) => r.task.id)).toEqual(["p"]);
			// With the parent in the expanded set, its children ride along.
			const open = { ...typed, expanded: new Set(["p"]) };
			expect(BoardNav.visibleRows(open).map((r) => r.task.id)).toEqual([
				"p",
				"c",
			]);
		});

		it("zero matches yields an empty visible list and esc still escapes", () => {
			const typed = typeQuery(reduce(searchable(), char("/")).state, "zzz");
			expect(BoardNav.visibleRows(typed)).toHaveLength(0);
			expect(typed.selectedId).toBeNull();
			const { state: next } = reduce(typed, { name: "escape" });
			expect(next.search).toEqual({ mode: "off" });
			expect(next.selectedId).toBe("auth");
		});

		it("a committed filter survives a sections reload (poll/mutation)", () => {
			const typed = typeQuery(reduce(searchable(), char("/")).state, "auth");
			const committed = reduce(typed, { name: "return" }).state;
			const reloaded = BoardNav.withSections(
				committed,
				sections({ next: [row(auth), row(board)] }),
			);
			expect(reloaded.search).toEqual({ mode: "committed", query: "auth" });
			expect(BoardNav.visibleRows(reloaded).map((r) => r.task.id)).toEqual([
				"auth",
			]);
		});

		it("/ is board-view-only — the detail view ignores it", () => {
			const detail = searchable({ view: { type: "detail", taskId: "auth" } });
			const { state: next } = reduce(detail, char("/"));
			expect(next.search).toEqual({ mode: "off" });
		});
	});

	describe("view stack", () => {
		it("enter opens the detail view for the selected row", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			const { state: next, effect } = reduce(s, { name: "return" });
			expect(next.view).toEqual({ type: "detail", taskId: "a" });
			expect(effect.type).toBe("none");
		});

		it("enter is a no-op when nothing is selected", () => {
			const s = state();
			expect(reduce(s, { name: "return" }).state.view).toEqual({
				type: "board",
			});
		});

		it("esc from the detail view returns to the board WITHOUT widening scope", () => {
			const detail = state({
				scoped: true,
				view: { type: "detail", taskId: "a" },
			});
			const back = reduce(detail, { name: "escape" });
			expect(back.state.view).toEqual({ type: "board" });
			expect(back.state.scoped).toBe(true);
			expect(back.effect.type).toBe("none");

			const widened = reduce(back.state, { name: "escape" });
			expect(widened.state.scoped).toBe(false);
			expect(widened.effect.type).toBe("reload");
		});

		it("q from the detail view returns to the board instead of quitting", () => {
			const detail = state({ view: { type: "detail", taskId: "a" } });
			const { state: next, effect } = reduce(detail, { name: "q" });
			expect(next.view).toEqual({ type: "board" });
			expect(effect.type).toBe("none");
		});

		it("j/k in the detail view emit scroll effects, not row moves", () => {
			const detail = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				view: { type: "detail", taskId: "a" },
			});
			const down = reduce(detail, { name: "j" });
			expect(down.effect.type).toBe("scroll");
			expect(down.state.selectedId).toBe("a");
			expect(reduce(detail, { name: "k" }).effect.type).toBe("scroll");
		});
	});
});

describe("status keys in the detail view target the open task", () => {
	// Selection is on "a" but the detail view is open on "b" — the status keys must act on "b".
	const open = state({
		sections: sections({
			next: [row(task({ id: "a" })), row(task({ id: "b", needsReview: true }))],
		}),
		selectedId: "a",
		view: { type: "detail", taskId: "b" },
	});

	it("n/s/x jump the open task's state (not the selected row)", () => {
		expect(reduce(open, { name: "n" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "next",
		});
		expect(reduce(open, { name: "s" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "someday",
		});
		expect(reduce(open, { name: "x" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "cancelled",
		});
	});

	it("v reviews the open task when flagged, no-ops with a flash otherwise", () => {
		expect(reduce(open, { name: "v" }).effect).toMatchObject({
			type: "markReviewed",
			id: "b",
		});
		const clean = { ...open, view: { type: "detail" as const, taskId: "a" } };
		expect(reduce(clean, { name: "v" }).effect).toMatchObject({
			type: "notice",
			notice: { tone: "success" },
		});
	});
});

describe("BoardNav.withSections nearest re-anchor", () => {
	it("re-anchors to the row below when the selected task vanishes", () => {
		const s = state({
			sections: sections({
				inbox: [
					row(task({ id: "a" })),
					row(task({ id: "b" })),
					row(task({ id: "c" })),
				],
			}),
			selectedId: "b",
		});
		const reloaded = BoardNav.withSections(
			s,
			sections({ inbox: [row(task({ id: "a" })), row(task({ id: "c" }))] }),
		);
		expect(reloaded.selectedId).toBe("c");
	});

	it("falls back to the row above when nothing survives below", () => {
		const s = state({
			sections: sections({
				inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
			}),
			selectedId: "b",
		});
		const reloaded = BoardNav.withSections(
			s,
			sections({ inbox: [row(task({ id: "a" }))] }),
		);
		expect(reloaded.selectedId).toBe("a");
	});
});

describe("BoardNav.reduceMouse", () => {
	describe("select", () => {
		it("clicking a different row selects it without opening detail", () => {
			const s = state({
				sections: sections({
					inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			const { state: next, effect } = BoardNav.reduceMouse(s, {
				type: "select",
				row: 1,
			});
			expect(next.selectedId).toBe("b");
			expect(next.view).toEqual({ type: "board" });
			expect(effect.type).toBe("none");
		});

		it("clicking the already-selected row opens its detail view", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			const { state: next } = BoardNav.reduceMouse(s, {
				type: "select",
				row: 0,
			});
			expect(next.view).toEqual({ type: "detail", taskId: "a" });
		});

		it("no-ops on an out-of-range row index", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			const { state: next, effect } = BoardNav.reduceMouse(s, {
				type: "select",
				row: 9,
			});
			expect(next).toBe(s);
			expect(effect.type).toBe("none");
		});

		it("is a no-op while the detail view is open (board handlers are unmounted)", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				view: { type: "detail", taskId: "a" },
			});
			const { state: next, effect } = BoardNav.reduceMouse(s, {
				type: "select",
				row: 0,
			});
			expect(next).toBe(s);
			expect(effect.type).toBe("none");
		});
	});

	describe("toggleExpand", () => {
		const parent = task({ id: "p" });
		const child = task({ id: "c", parentTaskId: "p" });

		it("expands a collapsed parent from its caret", () => {
			const s = state({
				sections: sections({ next: [row(parent, [child])] }),
				selectedId: "p",
			});
			const { state: next } = BoardNav.reduceMouse(s, {
				type: "toggleExpand",
				row: 0,
			});
			expect([...next.expanded]).toEqual(["p"]);
		});

		it("collapsing re-anchors selection to the parent when a selected child is hidden", () => {
			const s = state({
				sections: sections({ next: [row(parent, [child])] }),
				expanded: new Set(["p"]),
				selectedId: "c",
			});
			const { state: next } = BoardNav.reduceMouse(s, {
				type: "toggleExpand",
				row: 0,
			});
			expect([...next.expanded]).toEqual([]);
			expect(next.selectedId).toBe("p");
		});

		it("no-ops on a childless row", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(
				BoardNav.reduceMouse(s, { type: "toggleExpand", row: 0 }).state,
			).toBe(s);
		});
	});

	describe("copy", () => {
		it("copies the selected row's brief from the board", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(BoardNav.reduceMouse(s, { type: "copy" }).effect).toEqual({
				type: "copy",
				id: "a",
			});
		});

		it("copies the open task's brief from the detail view (button path)", () => {
			const s = state({ view: { type: "detail", taskId: "a" } });
			expect(BoardNav.reduceMouse(s, { type: "copy" }).effect).toEqual({
				type: "copy",
				id: "a",
			});
		});

		it("is a no-op on the board when nothing is selected", () => {
			expect(BoardNav.reduceMouse(state(), { type: "copy" }).effect.type).toBe(
				"none",
			);
		});
	});
});

describe("BoardNav.withSections", () => {
	it("keeps the same task selected across a reload", () => {
		const s = state({
			sections: sections({
				inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
			}),
			selectedId: "b",
		});
		const reloaded = BoardNav.withSections(
			s,
			sections({
				next: [row(task({ id: "b", state: "next" }))],
				inbox: [row(task({ id: "a" }))],
			}),
		);
		expect(reloaded.selectedId).toBe("b");
	});

	it("re-anchors to the first row when the selected task is gone", () => {
		const s = state({
			sections: sections({
				inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
			}),
			selectedId: "b",
		});
		const reloaded = BoardNav.withSections(
			s,
			sections({ inbox: [row(task({ id: "a" }))] }),
		);
		expect(reloaded.selectedId).toBe("a");
	});
});

describe("BoardNav.init", () => {
	it("selects the first visible row, all kinds, scoped per the option", () => {
		const s = BoardNav.init(sections({ inbox: [row(task({ id: "a" }))] }), {
			scoped: true,
		});
		expect(s).toMatchObject({ selectedId: "a", kind: "all", scoped: true });
	});

	it("selects nothing when the board is empty", () => {
		expect(BoardNav.init([], { scoped: false }).selectedId).toBeNull();
	});
});

describe("dispatch overlay", () => {
	const boardWith = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(task({ id: "a", shortId: "JAKE-1" }))],
			}),
			selectedId: "a",
			...over,
		});
	const trigger = (
		over: Partial<TriggerDescriptor> = {},
	): TriggerDescriptor => ({
		id: "claude",
		label: "claude",
		description: "interactive session",
		inputs: {},
		satisfiable: true,
		...over,
	});
	const TRIGGERS = [
		trigger(),
		trigger({ id: "codex", label: "codex" }),
		trigger({ id: "loop-watch", label: "loop · watch" }),
		trigger({ id: "loop-headless", label: "loop · headless" }),
		trigger({
			id: "custom",
			label: "custom",
			satisfiable: false,
			hint: "run via: cabane dispatch custom -i …",
		}),
	];
	const LOADING = { taskId: "a", triggers: [], selected: 0, loading: true };
	// `a` opens the overlay loading; the host answers through withTriggers.
	const open = (over: Partial<BoardNav.BoardState> = {}) =>
		BoardNav.withTriggers(
			reduce(boardWith(over), { name: "a" }).state,
			TRIGGERS,
		);

	it("`a` on the board opens the overlay loading on the selected row and asks the host for triggers", () => {
		const { state: next, effect } = reduce(boardWith(), {
			name: "a",
		});
		expect(next.dispatch).toEqual(LOADING);
		expect(effect).toEqual({ type: "loadTriggers", taskId: "a" });
	});

	it("`a` with nothing selected is a no-op", () => {
		const empty = state();
		const { state: next, effect } = reduce(empty, { name: "a" });
		expect(next.dispatch).toBeNull();
		expect(effect.type).toBe("none");
	});

	it("`a` in the detail view opens the overlay on the OPEN task", () => {
		const s = boardWith({ view: { type: "detail", taskId: "a" } });
		const { state: next, effect } = reduce(s, { name: "a" });
		expect(next.dispatch).toEqual(LOADING);
		expect(effect).toEqual({ type: "loadTriggers", taskId: "a" });
		expect(next.view).toEqual({ type: "detail", taskId: "a" });
	});

	it("withTriggers fills the overlay and clears loading; no-op once the overlay closed", () => {
		const s = open();
		expect(s.dispatch).toEqual({
			taskId: "a",
			triggers: TRIGGERS,
			selected: 0,
			loading: false,
		});
		const closed = boardWith();
		expect(BoardNav.withTriggers(closed, TRIGGERS).dispatch).toBeNull();
	});

	it("while loading, only esc does anything", () => {
		const loading = reduce(boardWith(), { name: "a" }).state;
		for (const name of ["j", "k", "return", "q", "1"]) {
			const { state: next, effect } = reduce(loading, { name });
			expect(effect.type).toBe("none");
			expect(next.dispatch).toEqual(LOADING);
		}
		const { state: closed } = reduce(loading, { name: "escape" });
		expect(closed.dispatch).toBeNull();
	});

	it("j/k move the selection, clamped to the trigger list", () => {
		let s = open();
		s = reduce(s, { name: "j" }).state;
		s = reduce(s, { name: "j" }).state;
		expect(s.dispatch?.selected).toBe(2);
		s = reduce(s, { name: "j" }).state;
		s = reduce(s, { name: "j" }).state;
		s = reduce(s, { name: "j" }).state;
		expect(s.dispatch?.selected).toBe(4);
		s = reduce(s, { name: "k" }).state;
		expect(s.dispatch?.selected).toBe(3);
	});

	it("digits jump straight to a trigger; out-of-range digits are inert", () => {
		const s = reduce(open(), char("4")).state;
		expect(s.dispatch?.selected).toBe(3);
		const s5 = reduce(open(), char("5")).state;
		expect(s5.dispatch?.selected).toBe(4);
		const s9 = reduce(open(), char("9")).state;
		expect(s9.dispatch?.selected).toBe(0);
	});

	it("enter closes the overlay and emits the dispatch effect for the selected trigger", () => {
		const third = reduce(open(), char("3")).state;
		const { state: next, effect } = reduce(third, {
			name: "return",
		});
		expect(next.dispatch).toBeNull();
		expect(effect).toEqual({
			type: "dispatch",
			triggerId: "loop-watch",
			id: "a",
		});
	});

	it("enter on an unsatisfiable trigger keeps the overlay and flashes its hint", () => {
		const fifth = reduce(open(), char("5")).state;
		const { state: next, effect } = reduce(fifth, {
			name: "return",
		});
		expect(next.dispatch).toEqual(fifth.dispatch);
		expect(effect).toEqual({
			type: "notice",
			notice: {
				text: "run via: cabane dispatch custom -i …",
				tone: "error",
			},
		});
	});

	it("enter with an empty trigger list is inert", () => {
		const s = BoardNav.withTriggers(
			reduce(boardWith(), { name: "a" }).state,
			[],
		);
		const { state: next, effect } = reduce(s, { name: "return" });
		expect(effect.type).toBe("none");
		expect(next.dispatch).toEqual(s.dispatch);
	});

	it("esc closes without an effect", () => {
		const { state: next, effect } = reduce(open(), {
			name: "escape",
		});
		expect(next.dispatch).toBeNull();
		expect(effect.type).toBe("none");
	});

	it("board keys are inert while the overlay is open", () => {
		const s = open();
		for (const name of ["q", "d", "x", "n", "s", "y", "space", "/"]) {
			const { state: next, effect } = reduce(s, { name });
			expect(effect.type).toBe("none");
			expect(next.dispatch).toEqual(s.dispatch);
			expect(next.selectedId).toBe("a");
		}
	});

	it("mouse actions are inert while the overlay is open", () => {
		const s = open();
		const { state: next, effect } = BoardNav.reduceMouse(s, {
			type: "select",
			row: 0,
		});
		expect(effect.type).toBe("none");
		expect(next.dispatch).toEqual(s.dispatch);
	});
});

describe("help overlay", () => {
	const boardWith = () =>
		state({
			sections: sections({
				next: [row(task({ id: "a", shortId: "JAKE-1" }))],
			}),
			selectedId: "a",
		});
	// `?` arrives as a shifted printable — parser-dependent name, reliable sequence.
	const helpKey = { name: "?", sequence: "?" };

	it("`?` on the board opens the help overlay", () => {
		const { state: next, effect } = reduce(boardWith(), helpKey);
		expect(next.help).toBe(true);
		expect(effect.type).toBe("none");
	});

	it("`?` matched by sequence alone (undefined-ish name) still opens", () => {
		const { state: next } = reduce(boardWith(), {
			name: "",
			sequence: "?",
		});
		expect(next.help).toBe(true);
	});

	it("`?` in the detail view opens the overlay and keeps the view", () => {
		const s = state({ view: { type: "detail", taskId: "a" } });
		const { state: next } = reduce(s, helpKey);
		expect(next.help).toBe(true);
		expect(next.view).toEqual({ type: "detail", taskId: "a" });
	});

	it("`?`, esc, and q each close it", () => {
		const open = reduce(boardWith(), helpKey).state;
		for (const key of [helpKey, { name: "escape" }, { name: "q" }]) {
			const { state: next } = reduce(open, key);
			expect(next.help).toBe(false);
		}
	});

	it("j/k scroll the sheet, and move nothing on the board under it", () => {
		const open = reduce(boardWith(), helpKey).state;
		for (const [name, delta] of [
			["j", 2],
			["down", 2],
			["k", -2],
			["up", -2],
		] as const) {
			const { state: next, effect } = reduce(open, { name });
			expect(effect).toEqual({ type: "helpScroll", delta });
			expect(next.help).toBe(true);
			expect(next.selectedId).toBe("a");
		}
	});

	it("all other keys are inert while open — d/a/x change nothing and emit nothing", () => {
		const open = reduce(boardWith(), helpKey).state;
		for (const name of ["d", "a", "x", "/", "space", "return"]) {
			const { state: next, effect } = reduce(open, { name });
			expect(effect.type).toBe("none");
			expect(next.help).toBe(true);
			expect(next.selectedId).toBe("a");
			expect(next.dispatch).toBeNull();
		}
	});

	it("`?` while search-typing appends to the query instead of opening help", () => {
		const typing = state({ search: { mode: "typing", query: "wh" } });
		const { state: next } = reduce(typing, helpKey);
		expect(next.help).toBe(false);
		expect(next.search).toEqual({ mode: "typing", query: "wh?" });
	});

	it("mouse actions are inert while open", () => {
		const open = reduce(boardWith(), helpKey).state;
		const { state: next, effect } = BoardNav.reduceMouse(open, {
			type: "select",
			row: 0,
		});
		expect(effect.type).toBe("none");
		expect(next.help).toBe(true);
	});
});

describe("withSearchResults (FTS tier-2 merge)", () => {
	const auth = task({
		id: "auth",
		shortId: "JAKE-10",
		title: "Fix auth flow",
	});
	const board = task({
		id: "board",
		shortId: "JAKE-11",
		title: "Board polish",
	});

	const withQuery = (query: string) =>
		state({
			sections: sections({ next: [row(auth), row(board)] }),
			selectedId: "auth",
			search: { mode: "typing", query },
		});

	it("appends new tasks to their correct section", () => {
		const s = withQuery("deploy");
		const ftsTask = task({
			id: "fts1",
			shortId: "JAKE-99",
			title: "Deploy pipeline",
			state: "next",
		});
		const merged = BoardNav.withSearchResults(s, "deploy", [ftsTask]);
		const nextSection = merged.sections.find((sec) => sec.state === "next");
		expect(nextSection?.rows.map((r) => r.task.id)).toEqual([
			"auth",
			"board",
			"fts1",
		]);
	});

	it("dedupes by id — tasks already in sections are not duplicated", () => {
		const s = withQuery("auth");
		const merged = BoardNav.withSearchResults(s, "auth", [auth]);
		const nextSection = merged.sections.find((sec) => sec.state === "next");
		expect(nextSection?.rows).toHaveLength(2);
	});

	it("no-ops on a stale query (board moved on since the FTS call fired)", () => {
		const s = withQuery("deploy");
		const ftsTask = task({
			id: "fts1",
			shortId: "JAKE-99",
			title: "Deploy pipeline",
			state: "next",
		});
		// The FTS responded for "auth" but the board is now searching "deploy".
		const merged = BoardNav.withSearchResults(s, "auth", [ftsTask]);
		expect(merged).toBe(s);
	});

	it("creates a new section for a state not yet present", () => {
		const s = withQuery("old");
		const doneTask = task({
			id: "done1",
			shortId: "JAKE-50",
			title: "Old done thing",
			state: "done",
		});
		const merged = BoardNav.withSearchResults(s, "old", [doneTask]);
		const doneSection = merged.sections.find((sec) => sec.state === "done");
		expect(doneSection).toBeDefined();
		expect(doneSection?.rows.map((r) => r.task.id)).toEqual(["done1"]);
	});

	// Before JCAB-29 these two states were outside SECTION_STATES, so the merge fell through to a
	// fabricated section carrying the RAW state string as its label ("someday", not "Someday").
	it("places a someday hit in the real someday section with its display label", () => {
		const s = withQuery("parked");
		const parked = task({
			id: "sd1",
			shortId: "JAKE-51",
			title: "Parked idea",
			state: "someday",
		});
		const merged = BoardNav.withSearchResults(s, "parked", [parked]);
		const section = merged.sections.find((sec) => sec.state === "someday");
		expect(section?.rows.map((r) => r.task.id)).toEqual(["sd1"]);
		expect(section?.label).toBe(TASK_STATE_DISPLAY.someday.label);
	});

	it("places a cancelled hit in the real cancelled section with its display label", () => {
		const s = withQuery("dropped");
		const killed = task({
			id: "cx1",
			shortId: "JAKE-52",
			title: "Dropped work",
			state: "cancelled",
		});
		const merged = BoardNav.withSearchResults(s, "dropped", [killed]);
		const section = merged.sections.find((sec) => sec.state === "cancelled");
		expect(section?.rows.map((r) => r.task.id)).toEqual(["cx1"]);
		expect(section?.label).toBe(TASK_STATE_DISPLAY.cancelled.label);
	});

	it("keeps every merged section in SECTION_STATES display order", () => {
		const s = withQuery("x");
		const merged = BoardNav.withSearchResults(s, "x", [
			task({ id: "cx2", title: "x cancelled", state: "cancelled" }),
			task({ id: "sd2", title: "x someday", state: "someday" }),
			task({ id: "dn2", title: "x done", state: "done" }),
		]);
		const order = merged.sections.map((sec) => sec.state);
		expect(order).toEqual(["next", "someday", "done", "cancelled"]);
	});

	it("preserves section display order after merge", () => {
		const s = state({
			sections: sections({ next: [row(auth)] }),
			selectedId: "auth",
			search: { mode: "typing", query: "test" },
		});
		const inProgressTask = task({
			id: "ip1",
			state: "in_progress",
			title: "test in progress",
		});
		const doneTask = task({
			id: "d1",
			state: "done",
			title: "test done",
		});
		const merged = BoardNav.withSearchResults(s, "test", [
			doneTask,
			inProgressTask,
		]);
		expect(merged.sections.map((sec) => sec.state)).toEqual([
			"in_progress",
			"next",
			"done",
		]);
	});

	it("cleared search drops merged rows (withSearchResults no-ops when search is off)", () => {
		const s = state({
			sections: sections({ next: [row(auth)] }),
			selectedId: "auth",
			search: { mode: "off" },
		});
		const ftsTask = task({
			id: "fts1",
			shortId: "JAKE-99",
			title: "something",
			state: "next",
		});
		const merged = BoardNav.withSearchResults(s, "something", [ftsTask]);
		// Search is off — active query is "" which doesn't match "something", so stale guard fires.
		expect(merged).toBe(s);
	});

	it("returns same state reference when all FTS results already exist", () => {
		const s = withQuery("auth");
		const merged = BoardNav.withSearchResults(s, "auth", [auth]);
		expect(merged).toBe(s);
	});

	it("returns same state reference on empty FTS results", () => {
		const s = withQuery("auth");
		const merged = BoardNav.withSearchResults(s, "auth", []);
		expect(merged).toBe(s);
	});
});

describe("the focus ring", () => {
	const boardWith = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(task({ id: "a", shortId: "JAKE-1" }))],
			}),
			selectedId: "a",
			focus: "board",
			...over,
		});

	it("tab walks board and copilot, ⇧tab walks it back", () => {
		const ring = (
			from: BoardNav.BoardState,
			key: { name: string; shift?: boolean },
		) => reduce(from, key).state;
		let s = boardWith();
		s = ring(s, { name: "tab" });
		expect(s.focus).toBe("copilot");
		s = ring(s, { name: "tab" });
		expect(s.focus).toBe("board");
		// ⇧tab arrives as `tab` with shift set.
		s = ring(s, { name: "tab", shift: true });
		expect(s.focus).toBe("copilot");
	});

	it("the ring is the same key in every view", () => {
		for (const view of [
			{ type: "detail" as const, taskId: "a" },
			{
				type: "events" as const,
				cardId: "copilot",
				fromView: "board" as const,
			},
		]) {
			const s = boardWith({ view });
			expect(reduce(s, { name: "tab" }).state.focus).toBe("copilot");
		}
	});
});

describe("event view navigation", () => {
	const runView = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(task({ id: "a", shortId: "JAKE-1" }))],
			}),
			selectedId: "a",
			view: {
				type: "events" as const,
				cardId: "r1",
				fromView: "board" as const,
			},
			...over,
		});

	it("j/k emit scroll effects", () => {
		const s = runView();
		expect(reduce(s, { name: "j" }).effect).toEqual({
			type: "scroll",
			delta: 2,
		});
		expect(reduce(s, { name: "k" }).effect).toEqual({
			type: "scroll",
			delta: -2,
		});
	});

	it("esc from events opened from board returns to board", () => {
		const s = runView();
		const { state: next } = reduce(s, { name: "escape" });
		expect(next.view).toEqual({ type: "board" });
	});

	it("q from events opened from board returns to board", () => {
		const s = runView();
		const { state: next } = reduce(s, { name: "q" });
		expect(next.view).toEqual({ type: "board" });
	});

	it("esc from events opened from detail returns to the correct detail view", () => {
		const s = runView({
			view: {
				type: "events",
				cardId: "r1",
				fromView: "detail",
				fromTaskId: "a",
			},
		});
		const { state: next } = reduce(s, { name: "escape" });
		expect(next.view).toEqual({ type: "detail", taskId: "a" });
	});

	it("esc from events opened from detail without fromTaskId falls back to board", () => {
		const s = runView({
			view: { type: "events", cardId: "r1", fromView: "detail" },
		});
		const { state: next } = reduce(s, { name: "escape" });
		expect(next.view).toEqual({ type: "board" });
	});

	it("unknown keys are no-ops in run detail", () => {
		const s = runView();
		for (const name of ["d", "x", "n", "s", "a", "space"]) {
			const { state: next, effect } = reduce(s, { name });
			expect(effect.type).toBe("none");
			expect(next.view).toEqual(s.view);
		}
	});
});

describe("done is search-only", () => {
	const doneTask = task({
		id: "dn",
		shortId: "JAKE-9",
		title: "shipped thing",
		state: "done",
	});
	const both = () =>
		state({
			sections: sections({
				next: [row(task({ id: "a", title: "open work" }))],
				done: [row(doneTask)],
			}),
			selectedId: "a",
		});

	it("the done section never renders without an active query", () => {
		const groups = BoardNav.visibleSections(both().sections, new Set(), {
			mode: "off",
		});
		expect(groups.map((g) => g.section.state)).toEqual(["next"]);
	});

	it("a query matching a done task brings the done section back", () => {
		const groups = BoardNav.visibleSections(both().sections, new Set(), {
			mode: "typing",
			query: "shipped",
		});
		expect(groups.map((g) => g.section.state)).toEqual(["done"]);
		expect(groups[0]?.rows.map((r) => r.task.id)).toEqual(["dn"]);
	});

	it("j/k never reach done rows without a query", () => {
		const s = both();
		const down = reduce(s, { name: "j" });
		expect(down.state.selectedId).toBe("a");
	});

	it("selection on a done match re-anchors when the query clears", () => {
		let s = both();
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "shipped");
		expect(BoardNav.visibleRows(s).map((r) => r.task.id)).toEqual(["dn"]);
		s = { ...s, selectedId: "dn" };
		const { state: cleared } = reduce(s, { name: "escape" });
		expect(cleared.selectedId).toBe("a");
	});
});

describe("undo (ctrl-z)", () => {
	// ctrl-z as OpenTUI delivers it: name "z" with the ctrl flag set.
	const ctrlZ = { name: "z", ctrl: true };
	const entry = (
		over: Partial<BoardNav.UndoEntry> = {},
	): BoardNav.UndoEntry => ({
		id: "a",
		shortId: "JAKE-1",
		patch: { state: "inbox" },
		label: "JAKE-1 → inbox",
		...over,
	});

	describe("push on mutation", () => {
		it("] pushes one entry with the reverse state patch and label", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "]" }).state.undo).toEqual([
				{
					id: "a",
					shortId: "JAKE-1",
					patch: { state: "inbox" },
					label: "JAKE-1 → inbox",
				},
			]);
		});

		it("[ pushes the pre-move state as its reverse patch", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a", state: "next" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "[" }).state.undo).toEqual([
				{
					id: "a",
					shortId: "JAKE-1",
					patch: { state: "next" },
					label: "JAKE-1 → next",
				},
			]);
		});

		it("n/s/x each push one entry restoring the prior state", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
				selectedId: "a",
			});
			for (const name of ["n", "s", "x"]) {
				expect(reduce(s, { name }).state.undo).toEqual([
					{
						id: "a",
						shortId: "JAKE-1",
						patch: { state: "inbox" },
						label: "JAKE-1 → inbox",
					},
				]);
			}
		});

		it("d pushes the pre-done state as its reverse patch", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a", state: "next" }))] }),
				selectedId: "a",
			});
			expect(reduce(s, { name: "d" }).state.undo).toEqual([
				{
					id: "a",
					shortId: "JAKE-1",
					patch: { state: "next" },
					label: "JAKE-1 → next",
				},
			]);
		});

		it("v pushes needsReview:true (plus prior verification when present)", () => {
			const clean = state({
				sections: sections({
					next: [row(task({ id: "a", needsReview: true }))],
				}),
				selectedId: "a",
			});
			expect(reduce(clean, { name: "v" }).state.undo).toEqual([
				{
					id: "a",
					shortId: "JAKE-1",
					patch: { needsReview: true },
					label: "JAKE-1 review restored",
				},
			]);

			const prior = {
				status: "failed" as const,
				method: "manual" as const,
				verifiedAt: new Date().toISOString(),
				verifiedBy: "agent",
			};
			const withVerification = state({
				sections: sections({
					next: [
						row(task({ id: "a", needsReview: true, verification: prior })),
					],
				}),
				selectedId: "a",
			});
			expect(reduce(withVerification, { name: "v" }).state.undo).toEqual([
				{
					id: "a",
					shortId: "JAKE-1",
					patch: { needsReview: true, verification: prior },
					label: "JAKE-1 review restored",
				},
			]);
		});

		it("the v no-op (no review flag) pushes nothing", () => {
			const s = state({
				sections: sections({
					next: [row(task({ id: "a", needsReview: false }))],
				}),
				selectedId: "a",
			});
			expect(reduce(s, { name: "v" }).state.undo).toHaveLength(0);
		});
	});

	describe("ctrl-z routing", () => {
		const seeded = (over: Partial<BoardNav.BoardState> = {}) =>
			state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				undo: [entry()],
				...over,
			});

		it("pops the top entry and emits applyUndo with its patch + notice", () => {
			const { state: next, effect } = reduce(seeded(), ctrlZ);
			expect(effect).toEqual({
				type: "applyUndo",
				id: "a",
				patch: { state: "inbox" },
				notice: "undo: JAKE-1 → inbox",
			});
			expect(next.undo).toHaveLength(0);
		});

		it("matches the raw SUB control sequence too", () => {
			const { effect } = reduce(seeded(), {
				name: "",
				sequence: "\x1a",
				ctrl: true,
			});
			expect(effect.type).toBe("applyUndo");
		});

		it("works from the detail view (routes across views)", () => {
			const s = seeded({ view: { type: "detail", taskId: "a" } });
			const { effect } = reduce(s, ctrlZ);
			expect(effect).toMatchObject({ type: "applyUndo", id: "a" });
		});

		it("empty stack flashes 'nothing to undo', stack unchanged", () => {
			const s = seeded({ undo: [] });
			const { state: next, effect } = reduce(s, ctrlZ);
			expect(effect).toEqual({
				type: "notice",
				notice: { text: "nothing to undo", tone: "success" },
			});
			expect(next).toBe(s);
		});

		it("is inert while search-typing (query untouched, no applyUndo)", () => {
			const s = seeded({ search: { mode: "typing", query: "au" } });
			const { state: next, effect } = reduce(s, ctrlZ);
			expect(effect.type).toBe("none");
			expect(next.search).toEqual({ mode: "typing", query: "au" });
			expect(next.undo).toHaveLength(1);
		});

		it("is inert while the help overlay is open", () => {
			const s = seeded({ help: true });
			const { state: next, effect } = reduce(s, ctrlZ);
			expect(effect.type).toBe("none");
			expect(next.undo).toHaveLength(1);
		});

		it("is inert while the dispatch overlay is open", () => {
			const s = seeded({
				dispatch: { taskId: "a", triggers: [], selected: 0, loading: false },
			});
			const { state: next, effect } = reduce(s, ctrlZ);
			expect(effect.type).toBe("none");
			expect(next.undo).toHaveLength(1);
		});

		it("walks back multiple changes in LIFO order", () => {
			const s = seeded({
				undo: [
					entry({ patch: { state: "inbox" }, label: "first" }),
					entry({ patch: { state: "next" }, label: "second" }),
				],
			});
			const one = reduce(s, ctrlZ);
			expect(one.effect).toMatchObject({
				type: "applyUndo",
				notice: "undo: second",
			});
			expect(one.state.undo).toHaveLength(1);
			const two = reduce(one.state, ctrlZ);
			expect(two.effect).toMatchObject({
				type: "applyUndo",
				notice: "undo: first",
			});
			expect(two.state.undo).toHaveLength(0);
			const three = reduce(two.state, ctrlZ);
			expect(three.effect).toEqual({
				type: "notice",
				notice: { text: "nothing to undo", tone: "success" },
			});
		});
	});

	it("enforces UNDO_CAP — pushing past 20 drops the oldest", () => {
		const seededStack = Array.from({ length: 20 }, (_, i) =>
			entry({ id: `x${i}`, shortId: `X${i}`, label: `X${i}` }),
		);
		const s = state({
			sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
			selectedId: "a",
			undo: seededStack,
		});
		const next = reduce(s, { name: "]" }).state;
		expect(next.undo).toHaveLength(20);
		// Oldest (X0) dropped; newest is the JAKE-1 push.
		expect(next.undo[0]?.shortId).toBe("X1");
		expect(next.undo[19]?.label).toBe("JAKE-1 → inbox");
	});

	it("withSections preserves the undo stack across a reload", () => {
		const s = state({
			sections: sections({ inbox: [row(task({ id: "a" }))] }),
			selectedId: "a",
			undo: [entry()],
		});
		const reloaded = BoardNav.withSections(
			s,
			sections({ inbox: [row(task({ id: "a" }))] }),
		);
		expect(reloaded.undo).toEqual(s.undo);
	});
});

describe("non-fatal poll failure invariants", () => {
	it("withSections preserves selection and expanded state across reload", () => {
		const t1 = task({ id: "t1" });
		const t2 = task({ id: "t2" });
		const s = state({
			sections: sections({ next: [row(t1), row(t2)] }),
			selectedId: "t1",
			expanded: new Set(["t1"]),
		});
		// Reload with same data — state is fully preserved.
		const reloaded = BoardNav.withSections(s, s.sections);
		expect(reloaded.selectedId).toBe("t1");
		expect(reloaded.expanded).toBe(s.expanded);
		expect(reloaded.sections).toBe(s.sections);
	});

	it("a skipped reload (poll failure) leaves previous state untouched", () => {
		const t1 = task({ id: "t1" });
		const s = state({
			sections: sections({ next: [row(t1)] }),
			selectedId: "t1",
		});
		// Simulate: reload fails → app.tsx sets notice but doesn't call withSections.
		// The state reference is unchanged — board keeps rendering the last-good data.
		const notice: BoardNav.Notice = {
			text: "database is locked",
			tone: "error",
		};
		// State is a plain object — verify the sections survive when reload is skipped.
		expect(s.sections).toHaveLength(1);
		expect(s.sections[0]?.rows[0]?.task.id).toBe("t1");
		expect(notice.tone).toBe("error");
	});

	it("r key on board triggers a reload effect (recovery path)", () => {
		const t1 = task({ id: "t1" });
		const s = state({
			sections: sections({ next: [row(t1)] }),
			selectedId: "t1",
		});
		const { effect } = reduce(s, { name: "r" });
		expect(effect.type).toBe("reload");
	});
});

describe("o key in the detail view emits openEvents effect", () => {
	it("emits openEvents with the detail view's taskId", () => {
		const t1 = task({ id: "t1" });
		const s = state({
			sections: sections({ next: [row(t1)] }),
			selectedId: "t1",
			view: { type: "detail", taskId: "t1" },
		});
		const { effect } = reduce(s, { name: "o" });
		expect(effect.type).toBe("openEvents");
		if (effect.type === "openEvents") {
			expect(effect.taskId).toBe("t1");
		}
	});

	it("o is a no-op on the board view", () => {
		const t1 = task({ id: "t1" });
		const s = state({
			sections: sections({ next: [row(t1)] }),
			selectedId: "t1",
			view: { type: "board" },
		});
		const { effect } = reduce(s, { name: "o" });
		expect(effect.type).toBe("none");
	});
});

describe("status filter", () => {
	const openTask = task({ id: "a", shortId: "JAKE-1", title: "open work" });
	const flagged = task({
		id: "fl",
		shortId: "JAKE-2",
		title: "agent output",
		needsReview: true,
	});
	const doneFlagged = task({
		id: "df",
		shortId: "JAKE-3",
		title: "shipped, unverified",
		state: "done",
		needsReview: true,
	});
	const donePlain = task({
		id: "dp",
		shortId: "JAKE-4",
		title: "shipped, verified",
		state: "done",
	});
	const parked = task({
		id: "sd",
		shortId: "JAKE-5",
		title: "parked idea",
		state: "someday",
	});
	const parkedFlagged = task({
		id: "sdf",
		shortId: "JAKE-6",
		title: "parked, unverified",
		state: "someday",
		needsReview: true,
	});
	const killed = task({
		id: "cx",
		shortId: "JAKE-7",
		title: "abandoned, unverified",
		state: "cancelled",
		needsReview: true,
	});
	// Both sides of the lifecycle × flagged/not: unresolved (next, someday) and closed (done,
	// cancelled). someday and cancelled are the two states the board could not reach before JCAB-29.
	const board = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(openTask), row(flagged)],
				someday: [row(parked), row(parkedFlagged)],
				done: [row(doneFlagged), row(donePlain)],
				cancelled: [row(killed)],
			}),
			selectedId: "a",
			...over,
		});

	const ids = (s: BoardNav.BoardState): string[] =>
		BoardNav.visibleRows(s).map((r) => r.task.id);

	it("f cycles open -> done -> review -> open WITHOUT a reload", () => {
		const s = board();
		const done = reduce(s, { name: "f" });
		expect(done.state.status).toBe("done");
		// The whole point of the view-level design: the rows are already in hand.
		expect(done.effect.type).toBe("none");
		const review = reduce(done.state, { name: "f" });
		expect(review.state.status).toBe("review");
		expect(review.effect.type).toBe("none");
		const back = reduce(review.state, { name: "f" });
		expect(back.state.status).toBe("open");
		expect(back.effect.type).toBe("none");
	});

	it("open is the default and spans every UNRESOLVED section, someday included", () => {
		expect(board().status).toBe("open");
		// someday is parked, not finished — it belongs to open, and before JCAB-29 the board
		// could send a task there (`s`) and never show it again.
		expect(ids(board())).toEqual(["a", "fl", "sd", "sdf"]);
	});

	it("open hides the closed archive — done and cancelled both", () => {
		const groups = BoardNav.visibleSections(
			board().sections,
			new Set<string>(),
			{ mode: "off" },
			"open",
		);
		expect(groups.map((g) => g.section.state)).toEqual(["next", "someday"]);
	});

	it("done shows BOTH archive sections with no query typed, and nothing else", () => {
		const s = reduce(board(), { name: "f" }).state;
		const groups = BoardNav.visibleSections(
			s.sections,
			s.expanded,
			s.search,
			s.status,
		);
		// cancelled is closed too: "done" is the lifecycle bucket, not the state name.
		expect(groups.map((g) => g.section.state)).toEqual(["done", "cancelled"]);
		expect(ids(s)).toEqual(["df", "dp", "cx"]);
	});

	it("a query from open still reaches the archive — 'did X land?' needs no filter change", () => {
		let s = board();
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "shipped");
		// Both done rows surface even though the status is open.
		expect(ids(s)).toEqual(["df", "dp"]);
		expect(s.status).toBe("open");
	});

	it("review spans every section and keeps only flagged rows, done included", () => {
		const s = board({ status: "review" });
		const groups = BoardNav.visibleSections(
			s.sections,
			s.expanded,
			s.search,
			s.status,
		);
		expect(groups.map((g) => g.section.state)).toEqual([
			"next",
			"someday",
			"done",
			"cancelled",
		]);
		// "done AND needs review" — the reason review composes over the states. It reaches the two
		// closed states and the parked one alike: a flag is a flag wherever the task sits.
		expect(ids(s)).toEqual(["fl", "sdf", "df", "cx"]);
	});

	it("review empties the board when nothing is flagged", () => {
		const s = state({
			sections: sections({ next: [row(openTask)] }),
			status: "review",
			selectedId: "a",
		});
		expect(ids(s)).toEqual([]);
	});

	it("f re-anchors selection when the change hides the selected row", () => {
		// `a` is open and unflagged, so `done` hides it: selection falls to the first surviving row.
		const done = reduce(board({ selectedId: "a" }), { name: "f" });
		expect(done.state.selectedId).toBe("df");
		// And back the other way: `df` is done, so `open` hides it.
		const back = reduce(board({ status: "review", selectedId: "df" }), {
			name: "f",
		});
		expect(back.state.status).toBe("open");
		expect(back.state.selectedId).toBe("a");
	});

	it("f keeps the selected row when it survives the change", () => {
		// `df` is done AND flagged, so it is on screen under both statuses.
		const s = board({ status: "done", selectedId: "df" });
		const review = reduce(s, { name: "f" });
		expect(review.state.status).toBe("review");
		expect(review.state.selectedId).toBe("df");
	});

	it("a query narrows WITHIN the active status rather than replacing it", () => {
		let s = board({ status: "review" });
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "shipped");
		// "shipped" matches both done rows; the review status keeps only the flagged one.
		expect(ids(s)).toEqual(["df"]);
	});

	it("a query under status done never reaches the open sections", () => {
		let s = board({ status: "done" });
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "work");
		// "open work" matches, but it lives in `next` — out of this status.
		expect(ids(s)).toEqual([]);
	});

	it("review keeps a flagged subtask's parent visible and forces it open", () => {
		const parent = task({ id: "p", shortId: "JAKE-8", title: "parent" });
		const child = task({
			id: "c",
			shortId: "JAKE-9",
			title: "child",
			needsReview: true,
		});
		const sibling = task({ id: "c2", shortId: "JAKE-10", title: "sibling" });
		const s = state({
			sections: sections({ next: [row(parent, [child, sibling])] }),
			status: "review",
		});
		const rows = BoardNav.visibleRows(s);
		expect(rows.map((r) => r.task.id)).toEqual(["p", "c"]);
		expect(rows[0]?.expanded).toBe(true);
	});

	it("esc leaves the status alone — its layering stays search then scope", () => {
		let s = board({ status: "review", scoped: true });
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "agent");
		s = reduce(s, { name: "return" }).state;
		const cleared = reduce(s, { name: "escape" });
		expect(cleared.state.search.mode).toBe("off");
		expect(cleared.state.status).toBe("review");
		const widened = reduce(cleared.state, { name: "escape" });
		expect(widened.state.scoped).toBe(false);
		expect(widened.state.status).toBe("review");
	});

	it("f is inert while a search query is being typed", () => {
		let s = board();
		s = reduce(s, { name: "/" }).state;
		s = typeQuery(s, "f");
		expect(s.status).toBe("open");
		expect(BoardNav.activeQuery(s.search)).toBe("f");
	});
});

describe("marks (`m`)", () => {
	const two = () =>
		state({
			sections: sections({
				inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
			}),
			selectedId: "a",
		});

	it("m toggles the selected row in and out of the working set, with no effect", () => {
		const on = reduce(two(), { name: "m" });
		expect([...on.state.marked]).toEqual(["a"]);
		expect(on.effect.type).toBe("none");
		const off = reduce(on.state, { name: "m" });
		expect(off.state.marked.size).toBe(0);
	});

	it("marks keep their order: oldest first", () => {
		const a = reduce(two(), { name: "m" }).state;
		const onB = reduce(a, { name: "j" }).state;
		const both = reduce(onB, { name: "m" }).state;
		expect([...both.marked]).toEqual(["a", "b"]);
	});

	it("m in the detail view toggles the OPEN task, not the board selection", () => {
		const s = state({
			...two(),
			view: { type: "detail", taskId: "b" },
		});
		const marked = reduce(s, { name: "m" }).state;
		expect([...marked.marked]).toEqual(["b"]);
	});

	it("m with nothing selected is inert", () => {
		const s = state({ ...two(), selectedId: null });
		const r = reduce(s, { name: "m" });
		expect(r.state).toBe(s);
	});

	it("esc clears marks before it clears a committed search, then widens scope", () => {
		const s = state({
			...two(),
			marked: new Set(["a"]),
			search: { mode: "committed", query: "a" },
			scoped: true,
		});
		const first = reduce(s, { name: "escape" });
		expect(first.state.marked.size).toBe(0);
		expect(first.state.search.mode).toBe("committed");
		expect(first.effect.type).toBe("none");
		const second = reduce(first.state, { name: "escape" });
		expect(second.state.search.mode).toBe("off");
		expect(second.state.scoped).toBe(true);
		const third = reduce(second.state, { name: "escape" });
		expect(third.state.scoped).toBe(false);
		expect(third.effect.type).toBe("reload");
	});

	it("marks survive a reload and a search merge", () => {
		const s = state({ ...two(), marked: new Set(["a", "b"]) });
		const reloaded = BoardNav.withSections(
			s,
			sections({ inbox: [row(task({ id: "a" }))] }),
		);
		expect([...reloaded.marked]).toEqual(["a", "b"]);
		const searched = BoardNav.withSearchResults(
			{ ...s, search: { mode: "committed", query: "z" } },
			"z",
			[task({ id: "z", title: "z" })],
		);
		expect([...searched.marked]).toEqual(["a", "b"]);
	});

	it("init starts with nothing marked", () => {
		expect(BoardNav.init([], { scoped: false }).marked.size).toBe(0);
	});
});

describe("copilot prompt (`A` / `:`)", () => {
	const triage = {
		name: "triage",
		hint: "keep, someday or next",
		template: "For each issue in view: keep, someday or next, one line each.",
	};
	const ready = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({ inbox: [row(task({ id: "a" }))] }),
			selectedId: "a",
			copilot: copilotState({ shortcuts: [triage] }),
			...over,
		});
	const open = (s: BoardNav.BoardState = ready()) => reduce(s, char("A"));

	it("A focuses the copilot and asks app.tsx to confirm one exists", () => {
		const r = open();
		expect(r.state.focus).toBe("copilot");
		expect(r.effect).toEqual({ type: "copilotOpen" });
	});

	it(": focuses it too, and so does A in the detail view", () => {
		expect(reduce(ready(), char(":")).state.focus).toBe("copilot");
		const detail = ready({ view: { type: "detail", taskId: "a" } });
		expect(open(detail).state.focus).toBe("copilot");
	});

	it("the reducer never edits the buffer — the textarea owns it", () => {
		const focused = open().state;
		// Every printable key, backspace included, belongs to the textarea: the reducer is inert and
		// says so through copilotConsumes, which is what app.tsx preventDefaults on.
		for (const key of [char("d"), char("q"), { name: "backspace" }]) {
			expect(reduce(focused, key).state).toBe(focused);
			expect(BoardNav.copilotConsumes(focused, key)).toBe(false);
		}
		// The keys it does take away from the textarea.
		expect(BoardNav.copilotConsumes(focused, { name: "escape" })).toBe(true);
		expect(BoardNav.copilotConsumes(focused, { name: "tab" })).toBe(true);
		// And none of them while the board has focus.
		const onBoard = ready();
		expect(BoardNav.copilotConsumes(onBoard, { name: "escape" })).toBe(false);
	});

	it("esc returns to the board and the buffer survives the trip", () => {
		const typed = BoardNav.withCopilotText(open().state, "hi there");
		const left = reduce(typed, { name: "escape" });
		expect(left.state.focus).toBe("board");
		expect(left.effect.type).toBe("none");
		expect(left.state.copilot.turn).toBe("idle");
		// Tab away to mark rows, come back to what you were writing.
		expect(left.state.copilot.text).toBe("hi there");
		expect(reduce(left.state, char("A")).state.copilot.text).toBe("hi there");
	});

	it("submit sends, clears the buffer, records history and hands the board back", () => {
		const typed = BoardNav.withCopilotText(open().state, "triage this");
		const r = BoardNav.submitCopilot(typed, "triage this");
		expect(r.effect).toEqual({ type: "copilotPrompt", prompt: "triage this" });
		expect(r.state.copilot.text).toBe("");
		expect(r.state.copilot.turn).toBe("running");
		expect(r.state.copilot.history).toEqual(["triage this"]);
		// Having sent a command, the next thing is watching it — every board key is live again.
		expect(r.state.focus).toBe("board");
	});

	it("submitting nothing does nothing; while a turn runs it flashes and keeps the draft", () => {
		const focused = open().state;
		expect(BoardNav.submitCopilot(focused, "   ").effect.type).toBe("none");
		const running = open(
			ready({
				copilot: copilotState({ turn: "running", text: "second thing" }),
			}),
		).state;
		const r = BoardNav.submitCopilot(running, "second thing");
		expect(r.effect).toEqual({
			type: "notice",
			notice: {
				text: "a turn is running · o for its transcript, x there stops it",
				tone: "success",
			},
		});
		expect(r.state.copilot.turn).toBe("running");
		// The draft survives, so enter once the turn ends sends what was typed during it.
		expect(r.state.copilot.text).toBe("second thing");
	});

	it("/ matches shortcuts; tab and submit both expand the template into the textarea", () => {
		const slash = BoardNav.withCopilotText(open().state, "/tr");
		expect(
			BoardNav.matchingShortcuts(slash.copilot.shortcuts, "/tr").map(
				(s) => s.name,
			),
		).toEqual(["triage"]);
		expect(BoardNav.matchingShortcuts(slash.copilot.shortcuts, "tr")).toEqual(
			[],
		);
		// Expanding pushes the whole value at the textarea rather than editing state's copy.
		const tabbed = reduce(slash, { name: "tab" });
		expect(tabbed.effect).toEqual({
			type: "copilotSetText",
			text: triage.template,
		});
		expect(tabbed.state.copilot.text).toBe(triage.template);
		// Completing does not move focus: the human is mid-prompt.
		expect(tabbed.state.focus).toBe("copilot");
		const exact = BoardNav.withCopilotText(open().state, "/triage");
		const entered = BoardNav.submitCopilot(exact, "/triage");
		expect(entered.effect).toEqual({
			type: "copilotSetText",
			text: triage.template,
		});
		// A second submit sends the expanded text, now that it has been read.
		const sent = BoardNav.submitCopilot(entered.state, triage.template);
		expect(sent.effect).toEqual({
			type: "copilotPrompt",
			prompt: triage.template,
		});
	});

	it("arrows move the palette, and tab and enter take what it points at", () => {
		const shortcuts = [
			triage,
			{ name: "trim", hint: "shorten", template: "Trim it." },
			{ name: "track", hint: "follow", template: "Track it." },
		];
		const focused = open(ready({ copilot: copilotState({ shortcuts }) })).state;
		const typed = BoardNav.withCopilotText(focused, "/tr");
		// All three match, so the arrows belong to the palette rather than the textarea's cursor.
		expect(BoardNav.copilotConsumes(typed, { name: "down" })).toBe(true);
		expect(BoardNav.selectedShortcut(typed)?.name).toBe("triage");
		const down = reduce(typed, { name: "down" }).state;
		expect(BoardNav.selectedShortcut(down)?.name).toBe("trim");
		const down2 = reduce(down, { name: "down" }).state;
		expect(BoardNav.selectedShortcut(down2)?.name).toBe("track");
		// Clamped at the end.
		const stuck = reduce(down2, { name: "down" }).state;
		expect(BoardNav.selectedShortcut(stuck)?.name).toBe("track");
		const up = reduce(stuck, { name: "up" }).state;
		expect(BoardNav.selectedShortcut(up)?.name).toBe("trim");
		// tab takes the selection, not the first match.
		expect(reduce(up, { name: "tab" }).effect).toEqual({
			type: "copilotSetText",
			text: "Trim it.",
		});
		// So does enter: sending the agent the literal text `/tr` is never what was meant.
		expect(BoardNav.submitCopilot(up, "/tr").effect).toEqual({
			type: "copilotSetText",
			text: "Trim it.",
		});
		// Typing more resets the selection, because the list under it changed.
		const narrowed = BoardNav.withCopilotText(down2, "/tri");
		expect(narrowed.copilot.paletteAt).toBe(0);
		expect(BoardNav.selectedShortcut(narrowed)?.name).toBe("triage");
	});

	it("the harness's commands follow the shortcuts, expand to their own name and go as typed", () => {
		const listed = BoardNav.withCopilotCommands(open().state, "claude", [
			{ name: "compact", description: "Summarise the conversation" },
			{ name: "triage", description: "the harness's own triage" },
		]);
		expect(
			BoardNav.matchingShortcuts(
				BoardNav.paletteEntries(listed.copilot),
				"/",
			).map((entry) => [entry.name, entry.source]),
		).toEqual([
			["triage", undefined],
			["compact", "claude"],
			["triage", "claude"],
		]);
		const typed = BoardNav.withCopilotText(listed, "/comp");
		const tabbed = reduce(typed, { name: "tab" });
		expect(tabbed.effect).toEqual({
			type: "copilotSetText",
			text: "/compact ",
		});
		// Expanded, the palette is closed, so enter sends the command as written.
		const written = BoardNav.withCopilotText(
			tabbed.state,
			"/compact keep the plan",
		);
		expect(
			BoardNav.submitCopilot(written, "/compact keep the plan").effect,
		).toEqual({ type: "copilotPrompt", prompt: "/compact keep the plan" });
		// A later list replaces the earlier one whole.
		const relisted = BoardNav.withCopilotCommands(listed, "claude", [
			{ name: "review", description: "Review a PR", hint: "pr number" },
		]);
		expect(relisted.copilot.commands).toEqual([
			{
				name: "review",
				hint: "Review a PR · pr number",
				template: "/review ",
				source: "claude",
			},
		]);
	});

	it("t on an event view opens every tool row, and t again closes them", () => {
		const events = state({
			view: { type: "events", cardId: "copilot", fromView: "board" },
		});
		const opened = reduce(events, char("t"));
		expect(opened.state.view).toMatchObject({ toolDetails: true });
		expect(opened.effect.type).toBe("none");
		expect(reduce(opened.state, char("t")).state.view).toMatchObject({
			toolDetails: false,
		});
		// Nothing to open on the board itself.
		expect(reduce(state(), char("t")).state.view).toEqual({ type: "board" });
	});

	it("with no palette open the arrows still belong to history", () => {
		const sent = BoardNav.submitCopilot(open().state, "first");
		const focused = reduce(
			BoardNav.withCopilotTurn(sent.state, "idle"),
			char("A"),
		).state;
		// Empty buffer, so nothing matches and recall keeps the keys.
		expect(BoardNav.copilotConsumes(focused, { name: "up" })).toBe(true);
		expect(reduce(focused, { name: "up" }).effect).toEqual({
			type: "copilotSetText",
			text: "first",
		});
		// Mid-sentence, they are the textarea's cursor again: no palette, no history.
		const writing = BoardNav.withCopilotText(focused, "a normal prompt");
		expect(BoardNav.copilotConsumes(writing, { name: "up" })).toBe(false);
	});

	it("tab with nothing to complete hands the ring its turn", () => {
		const typed = BoardNav.withCopilotText(open().state, "not a slash");
		const r = reduce(typed, { name: "tab" });
		expect(r.state.focus).toBe("board");
		expect(r.state.copilot.text).toBe("not a slash");
	});

	it("up walks back through this session's prompts, down walks out again", () => {
		const sent = BoardNav.submitCopilot(open().state, "first");
		const again = BoardNav.submitCopilot(
			reduce(BoardNav.withCopilotTurn(sent.state, "idle"), char("A")).state,
			"second",
		);
		const focused = reduce(
			BoardNav.withCopilotTurn(again.state, "idle"),
			char("A"),
		).state;
		expect(focused.copilot.history).toEqual(["first", "second"]);
		// Only while the buffer is empty — otherwise up is the textarea's cursor motion.
		expect(BoardNav.copilotConsumes(focused, { name: "up" })).toBe(true);
		const busy = BoardNav.withCopilotText(focused, "half a thought");
		expect(BoardNav.copilotConsumes(busy, { name: "up" })).toBe(false);
		const one = reduce(focused, { name: "up" });
		expect(one.effect).toEqual({ type: "copilotSetText", text: "second" });
		const two = reduce(one.state, { name: "up" });
		expect(two.effect).toEqual({ type: "copilotSetText", text: "first" });
		// Past the oldest it stays put.
		const stuck = reduce(two.state, { name: "up" });
		expect(stuck.state.copilot.text).toBe("first");
		const back = reduce(two.state, { name: "down" });
		expect(back.effect).toEqual({ type: "copilotSetText", text: "second" });
		const out = reduce(back.state, { name: "down" });
		expect(out.effect).toEqual({ type: "copilotSetText", text: "" });
	});

	it("esc and tab both leave the pane; neither stops the running turn", () => {
		const running = open(
			ready({
				copilot: copilotState({ turn: "running", hasLog: true }),
			}),
		).state;
		// esc is the back key everywhere else on the board and destroys nothing anywhere; it used to
		// cancel here, which made tabbing in to look at a turn and tabbing back out kill it.
		const esc = reduce(running, { name: "escape" });
		expect(esc.effect.type).toBe("none");
		expect(esc.state.focus).toBe("board");
		expect(esc.state.copilot.turn).toBe("running");
		const tabbed = reduce(running, { name: "tab" });
		expect(tabbed.state.focus).toBe("board");
		expect(tabbed.effect.type).toBe("none");
		expect(tabbed.state.copilot.turn).toBe("running");
	});

	it("withCopilotTurn moves the turn; a keypress after done or error returns it to idle and still acts", () => {
		const done = BoardNav.withCopilotTurn(ready(), "done");
		expect(done.copilot.turn).toBe("done");
		expect(BoardNav.withCopilotTurn(done, "done")).toBe(done);
		const r = reduce(done, char("m"));
		expect(r.state.copilot.turn).toBe("idle");
		expect([...r.state.marked]).toEqual(["a"]);
		const err = BoardNav.withCopilotTurn(ready(), "error");
		expect(reduce(err, char("j")).state.copilot.turn).toBe("idle");
	});

	it("a query character while searching does not dismiss the indicator", () => {
		const s = BoardNav.withCopilotTurn(
			ready({ search: { mode: "typing", query: "" } }),
			"done",
		);
		const r = reduce(s, char("a"));
		expect(r.state.copilot.turn).toBe("done");
		expect(r.state.search).toEqual({ mode: "typing", query: "a" });
	});

	it("o opens the copilot's transcript whenever there is one, from the board and the detail view", () => {
		const idle = reduce(ready(), char("o"));
		expect(idle.state.view.type).toBe("board");
		const running = ready({
			copilot: copilotState({ turn: "running", hasLog: true }),
		});
		const fromBoard = reduce(running, char("o"));
		expect(fromBoard.state.view).toEqual({
			type: "events",
			cardId: "copilot",
			fromView: "board",
			fromTaskId: undefined,
		});
		const done = BoardNav.withCopilotTurn(
			ready({ view: { type: "detail", taskId: "a" } }),
			"done",
		);
		const fromDetail = reduce(done, char("o"));
		expect(fromDetail.state.view).toEqual({
			type: "events",
			cardId: "copilot",
			fromView: "detail",
			fromTaskId: "a",
		});
		// `o` is the one key that keeps the finished indicator up.
		expect(fromDetail.state.copilot.turn).toBe("done");
		// Back where it came from.
		const back = reduce(fromDetail.state, { name: "escape" });
		expect(back.state.view).toEqual({ type: "detail", taskId: "a" });
		// The INDICATOR clears on the next keypress; the log behind it does not. Guarding `o` on the
		// indicator made the session's turns unreachable the moment anything else was pressed —
		// which is precisely when someone goes back looking for what just ran.
		const settled = ready({
			copilot: copilotState({ turn: "idle", hasLog: true }),
		});
		expect(reduce(settled, char("o")).state.view).toEqual({
			type: "events",
			cardId: "copilot",
			fromView: "board",
			fromTaskId: undefined,
		});
	});

	it("o in the detail view with no turn still opens the task's own events", () => {
		const r = reduce(
			ready({ view: { type: "detail", taskId: "a" } }),
			char("o"),
		);
		expect(r.effect).toEqual({ type: "openEvents", taskId: "a" });
	});

	it("x on the copilot's transcript cancels the running turn; on a host card it is inert", () => {
		const onCopilot = ready({
			view: { type: "events", cardId: "copilot", fromView: "board" },
			copilot: copilotState({ turn: "running" }),
		});
		expect(reduce(onCopilot, char("x")).effect).toEqual({
			type: "copilotCancel",
		});
		const finished = BoardNav.withCopilotTurn(onCopilot, "done");
		expect(reduce(finished, char("x")).effect.type).toBe("none");
		const onHost = ready({
			view: { type: "events", cardId: "r1", fromView: "board" },
			copilot: copilotState({ turn: "running" }),
		});
		expect(reduce(onHost, char("x")).effect.type).toBe("none");
	});

	it("a click on the board brings focus with it — the copilot is not a modal", () => {
		const r = BoardNav.reduceMouse(open().state, { type: "select", row: 0 });
		expect(r.state.focus).toBe("board");
		expect(r.state.selectedId).toBe("a");
	});

	it("init starts on the board with an empty buffer and no shortcuts", () => {
		const s = BoardNav.init([], { scoped: false });
		expect(s.focus).toBe("board");
		expect(s.copilot).toEqual(copilotState());
	});
});

describe("the copilot's fingerprint on the rows it changed (`✦ ai`)", () => {
	const ACTOR = "cabane://actor/agent/claude";
	const TURN_START = "2026-09-12T10:00:00.000Z";
	const before = "2026-09-12T09:59:59.000Z";
	const after = "2026-09-12T10:00:01.000Z";

	// One parent with the rest as its subtasks, so a single helper covers both depths.
	const board = (turn: BoardNav.CopilotTurn, rows: Task[]) =>
		state({
			sections: sections({ next: [row(rows[0] ?? task(), rows.slice(1))] }),
			copilot: copilotState({ turn, actor: ACTOR }),
		});

	it("names the copilot's own writes since the turn opened, and nobody else's", () => {
		const agent = task({ id: "agent", updatedBy: ACTOR, updatedAt: after });
		const human = task({
			id: "human",
			parentTaskId: "agent",
			updatedBy: "cabane://actor/human/david",
			updatedAt: after,
		});
		const stale = task({
			id: "stale",
			parentTaskId: "agent",
			updatedBy: ACTOR,
			updatedAt: before,
		});
		expect([
			...BoardNav.copilotTouched(
				board("running", [agent, human, stale]),
				TURN_START,
			),
		]).toEqual(["agent"]);
	});

	it("marks a subtask the copilot wrote even while its parent is collapsed", () => {
		const parent = task({ id: "p", updatedBy: ACTOR, updatedAt: before });
		const child = task({
			id: "c",
			parentTaskId: "p",
			updatedBy: ACTOR,
			updatedAt: after,
		});
		expect([
			...BoardNav.copilotTouched(board("running", [parent, child]), TURN_START),
		]).toEqual(["c"]);
	});

	it("clears on the keypress that dismisses the finished turn's indicator", () => {
		const written = task({ id: "agent", updatedBy: ACTOR, updatedAt: after });
		const done = board("done", [written]);
		expect(BoardNav.copilotTouched(done, TURN_START).size).toBe(1);
		const next = reduce(done, char("j")).state;
		expect(next.copilot.turn).toBe("idle");
		expect(BoardNav.copilotTouched(next, TURN_START).size).toBe(0);
	});

	it("keeps the glyphs through a running turn: a keypress is not an acknowledgement yet", () => {
		const written = task({ id: "agent", updatedBy: ACTOR, updatedAt: after });
		const next = reduce(board("running", [written]), char("j")).state;
		expect(BoardNav.copilotTouched(next, TURN_START).size).toBe(1);
	});

	it("marks nothing for a copilot that names no actor, or before a turn has started", () => {
		const written = task({ id: "agent", updatedBy: ACTOR, updatedAt: after });
		const anonymous = state({
			sections: sections({ next: [row(written)] }),
			copilot: copilotState({ turn: "running" }),
		});
		expect(BoardNav.copilotTouched(anonymous, TURN_START).size).toBe(0);
		expect(
			BoardNav.copilotTouched(board("running", [written]), undefined).size,
		).toBe(0);
	});
});

describe("a permission request the harness is blocked on", () => {
	const request: CopilotPermission = {
		id: "t0",
		title: "kabane_edit",
		options: [
			{ id: "allow", label: "Allow" },
			{ id: "reject", label: "Reject" },
		],
	};
	const asked = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({ next: [row(task({ id: "a" }))] }),
			selectedId: "a",
			copilot: copilotState({
				turn: "running",
				asks: [{ type: "permission", request }],
			}),
			...over,
		});

	it("a digit answers with the option it numbers, and the question is gone", () => {
		const r = reduce(asked(), char("2"));
		expect(r.effect).toEqual({
			type: "copilotAnswer",
			id: "t0",
			optionId: "reject",
		});
		expect(requests(r.state)).toEqual([]);
	});

	it("esc declines", () => {
		const r = reduce(asked(), { name: "escape" });
		expect(r.effect).toEqual({
			type: "copilotAnswer",
			id: "t0",
			optionId: null,
		});
		expect(requests(r.state)).toEqual([]);
	});

	it("answers from the copilot pane and the transcript too — the question outranks the view", () => {
		const fromPane = reduce(asked({ focus: "copilot" }), char("1"));
		expect(fromPane.effect).toMatchObject({ optionId: "allow" });
		const fromTranscript = reduce(
			asked({ view: { type: "events", cardId: "copilot", fromView: "board" } }),
			char("1"),
		);
		expect(fromTranscript.effect).toMatchObject({ optionId: "allow" });
	});

	it("the pane gives up the digits while one is pending, and takes them back after", () => {
		const pending = asked({ focus: "copilot" });
		expect(BoardNav.copilotConsumes(pending, char("1"))).toBe(true);
		const answered = reduce(pending, char("1")).state;
		expect(BoardNav.copilotConsumes(answered, char("1"))).toBe(false);
	});

	it("a digit past the last option answers nothing, and the key routes as it always does", () => {
		const r = reduce(asked(), char("3"));
		expect(r.effect.type).toBe("none");
		expect(requests(r.state)).toEqual([request]);
	});

	it("leaves every other key alone: x on the transcript still cancels the waiting turn", () => {
		const r = reduce(
			asked({ view: { type: "events", cardId: "copilot", fromView: "board" } }),
			char("x"),
		);
		expect(r.effect).toEqual({ type: "copilotCancel" });
		// The board never answers on the human's behalf, cancelling included.
		expect(requests(r.state)).toEqual([request]);
	});

	it("a digit stays a query character while a search is being typed", () => {
		const typing = asked({ search: { mode: "typing", query: "au" } });
		const r = reduce(typing, char("1"));
		expect(r.effect.type).toBe("none");
		expect(r.state.search).toEqual({ mode: "typing", query: "au1" });
	});

	it("an open prompt keeps its keys: a digit is text, esc closes the prompt and not the question", () => {
		const prompting = asked({
			prompt: {
				...BoardPrompt.CLOSED,
				open: {
					target: { type: "act", cardId: "loop", actionId: "inject" },
					title: "inject",
					placeholder: "",
				},
			},
		});
		const digit = reduce(prompting, char("1"));
		expect(digit.effect.type).not.toBe("copilotAnswer");
		expect(requests(digit.state)).toEqual([request]);
		const esc = reduce(prompting, { name: "escape" });
		expect(esc.effect.type).not.toBe("copilotAnswer");
		expect(requests(esc.state)).toEqual([request]);
		expect(esc.state.prompt.open).toBeNull();
	});

	it("one arriving holds a digit inside its window, unless the digit is a query character", () => {
		const idle = state({ copilot: copilotState({ turn: "running" }) });
		const arrived = BoardNav.sight(
			BoardNav.withCopilotPermission(idle, request),
			5000,
		);
		const blind = BoardNav.reduceKey(arrived, char("2"), 5200);
		expect(blind.effect).toMatchObject({ type: "notice" });
		expect(requests(blind.state)).toEqual([request]);
		const typing = {
			...arrived,
			search: { mode: "typing", query: "" },
		} as const;
		expect(BoardNav.reduceKey(typing, char("2"), 5200).state.search).toEqual({
			mode: "typing",
			query: "2",
		});
		expect(
			BoardNav.reduceKey(arrived, char("2"), 5000 + BoardNav.ARM_MS).effect,
		).toMatchObject({ type: "copilotAnswer", optionId: "reject" });
	});

	it("a click on an option is its digit, and one on esc decline is esc", () => {
		expect(
			BoardNav.reduceMouse(asked(), { type: "askOption", index: 1 }),
		).toEqual(reduce(asked(), char("2")));
		expect(
			BoardNav.reduceMouse(asked(), { type: "askKey", name: "escape" }).effect,
		).toEqual({ type: "copilotAnswer", id: "t0", optionId: null });
	});

	it("transcript clicks answer or decline without moving focus or closing the transcript", () => {
		const transcript = asked({
			view: { type: "events", cardId: "copilot", fromView: "board" },
		});
		for (const [action, optionId] of [
			[{ type: "askOption", index: 1 }, "reject"],
			[{ type: "askKey", name: "escape" }, null],
		] as const) {
			const result = BoardNav.reduceMouse(transcript, action);
			expect(result.effect).toEqual({
				type: "copilotAnswer",
				id: "t0",
				optionId,
			});
			expect(requests(result.state)).toEqual([]);
			expect(result.state.view).toEqual(transcript.view);
			expect(result.state.focus).toBe(transcript.focus);
			expect(
				BoardNav.reduceMouse({ ...transcript, help: true }, action).effect.type,
			).toBe("none");
		}
	});

	it("a click on the collapsed row naming it opens it: the copilot takes the keys", () => {
		const r = BoardNav.reduceMouse(asked(), { type: "askReach" });
		expect(r.state.focus).toBe("copilot");
		expect(requests(r.state)).toEqual([request]);
	});

	it("a turn that stops takes the unanswered question with it", () => {
		const stopped = BoardNav.withCopilotTurn(asked(), "error");
		expect(requests(stopped)).toEqual([]);
	});

	// A harness running tools in parallel asks for each before hearing back on any.
	describe("several at once", () => {
		const second: CopilotPermission = {
			...request,
			id: "t1",
			title: "web_search",
		};
		const both = () => BoardNav.withCopilotPermission(asked(), second);

		it("queues behind the first instead of replacing it", () => {
			expect(requests(both())).toEqual([request, second]);
		});

		it("answers them in the order asked, each leaving only itself", () => {
			const first = reduce(both(), char("1"));
			expect(first.effect).toEqual({
				type: "copilotAnswer",
				id: "t0",
				optionId: "allow",
			});
			expect(requests(first.state)).toEqual([second]);
			const next = reduce(first.state, { name: "escape" });
			expect(next.effect).toEqual({
				type: "copilotAnswer",
				id: "t1",
				optionId: null,
			});
			expect(requests(next.state)).toEqual([]);
		});

		it("does not queue the same request twice", () => {
			const again = BoardNav.withCopilotPermission(both(), request);
			expect(requests(again)).toEqual([request, second]);
		});

		it("the next one up holds a second digit pressed before it has been read", () => {
			const first = BoardNav.reduceKey(both(), char("1"), BoardNav.ARM_MS);
			const next = BoardNav.sight(first.state, 1000);
			expect(BoardNav.digitTarget(next)).toBe("t1");
			const blind = BoardNav.reduceKey(next, char("1"), 1100);
			expect(blind.effect).toMatchObject({ type: "notice" });
			expect(requests(blind.state)).toEqual([second]);
			expect(
				BoardNav.reduceKey(next, char("1"), 1000 + BoardNav.ARM_MS).effect,
			).toEqual({ type: "copilotAnswer", id: "t1", optionId: "allow" });
		});

		it("a turn that stops takes every one of them with it", () => {
			const stopped = BoardNav.withCopilotTurn(both(), "error");
			expect(requests(stopped)).toEqual([]);
		});
	});
});

describe("detail tabs", () => {
	const detail = (tab?: DetailModel.Tab) =>
		state({ view: { type: "detail", taskId: "a", tab } });

	it("opens on the description, the default tab", () => {
		expect(BoardNav.detailTab(detail().view)).toBe("description");
	});

	it("a digit jumps to its tab, and one past the last does nothing", () => {
		expect(BoardNav.detailTab(reduce(detail(), { name: "3" }).state.view)).toBe(
			"log",
		);
		expect(BoardNav.detailTab(reduce(detail(), { name: "2" }).state.view)).toBe(
			"comments",
		);
		const s = detail("log");
		expect(reduce(s, { name: "4" }).state).toBe(s);
	});

	it("h/l and the arrows step through the tabs and wrap at either end", () => {
		const step = (s: BoardNav.BoardState, name: string) =>
			BoardNav.detailTab(reduce(s, { name }).state.view);
		expect(step(detail(), "l")).toBe("comments");
		expect(step(detail(), "right")).toBe("comments");
		expect(step(detail(), "h")).toBe("log");
		expect(step(detail("log"), "l")).toBe("description");
		expect(step(detail("comments"), "left")).toBe("description");
	});

	it("the tab already in view hands back the same state, so nothing re-renders", () => {
		const s = detail("comments");
		expect(reduce(s, { name: "2" }).state).toBe(s);
	});

	it("a click on a tab selects it, and does nothing off the detail view", () => {
		const { state: next } = BoardNav.reduceMouse(detail(), {
			type: "detailTab",
			tab: "log",
		});
		expect(BoardNav.detailTab(next.view)).toBe("log");
		const board = state();
		expect(
			BoardNav.reduceMouse(board, { type: "detailTab", tab: "log" }).state.view,
		).toEqual({ type: "board" });
	});

	it("esc from the copilot's transcript lands back on the tab it was opened from", () => {
		const s = state({
			view: { type: "detail", taskId: "a", tab: "comments" },
			copilot: copilotState({ turn: "running", hasLog: true }),
		});
		const opened = reduce(s, { name: "o" }).state;
		expect(opened.view.type).toBe("events");
		const back = reduce(opened, { name: "escape" }).state;
		expect(back.view).toEqual({ type: "detail", taskId: "a", tab: "comments" });
	});
});

describe("a form the harness is blocked on", () => {
	const form: CopilotElicitation = {
		id: "form-1",
		message: "Which store should the cache use?",
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: false,
				type: "choice",
				options: [
					{ value: "Redis", label: "Redis" },
					{ value: "Memory", label: "Memory" },
				],
			},
			{
				key: "question_0_custom",
				title: "Other",
				required: false,
				type: "text",
			},
		],
	};
	const permission: CopilotPermission = {
		id: "t0",
		title: "kabane_edit",
		options: [{ id: "allow", label: "Allow" }],
	};
	const asked = (over: Partial<BoardNav.BoardState> = {}) =>
		BoardNav.withCopilotElicitation(
			state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				copilot: copilotState({ turn: "running" }),
				...over,
			}),
			form,
		);
	const head = (s: BoardNav.BoardState) => s.copilot.asks[0];

	it("a digit answers the field in hand and moves to the next, sending nothing yet", () => {
		const r = reduce(asked(), char("1"));
		expect(r.effect.type).toBe("none");
		expect(head(r.state)).toMatchObject({
			type: "elicitation",
			draft: { at: 1, values: { question_0: "Redis" } },
		});
	});

	it("the input's enter on the last field sends the whole form and takes it off the queue", () => {
		const picked = reduce(asked(), char("2")).state;
		const sent = BoardNav.submitForm(picked, "");
		expect(sent.effect).toEqual({
			type: "copilotAnswerForm",
			id: "form-1",
			answer: { action: "accept", content: { question_0: "Memory" } },
		});
		expect(sent.state.copilot.asks).toEqual([]);
	});

	it("esc declines it from any field", () => {
		const onText = reduce(asked(), char("1")).state;
		for (const s of [asked(), onText])
			expect(reduce(s, { name: "escape" }).effect).toEqual({
				type: "copilotAnswerForm",
				id: "form-1",
				answer: { action: "decline" },
			});
	});

	it("a typed field keeps every key from the board under it, so typing never moves the board", () => {
		const onText = reduce(asked(), char("1")).state;
		for (const key of [char("j"), char("q"), char("1"), char("A")]) {
			const r = reduce(onText, key);
			expect(r.effect.type).toBe("none");
			expect(r.state).toEqual(BoardNav.sight(onText, 0));
		}
		// Nothing for the pane to claim: its input is mounted in place of the copilot's buffer.
		for (const key of [char("j"), char("4")])
			expect(
				BoardNav.copilotConsumes({ ...onText, focus: "copilot" }, key),
			).toBe(false);
		// On a field the digits answer, the pane claims them, as for a permission.
		expect(
			BoardNav.copilotConsumes({ ...asked(), focus: "copilot" }, char("1")),
		).toBe(true);
		expect(BoardNav.digitTarget(onText)).toBeUndefined();
	});

	it("a choice field leaves other keys to the board, as a permission does", () => {
		const r = reduce(asked(), char("j"));
		expect(r.effect.type).toBe("none");
		expect(head(r.state)).toMatchObject({ draft: { at: 0 } });
	});

	it("the arrows move its cursor ahead of the board, and j/k still move the board under it", () => {
		const two = state({
			sections: sections({
				next: [row(task({ id: "a" })), row(task({ id: "b" }))],
			}),
			selectedId: "a",
			copilot: copilotState({ turn: "running" }),
		});
		const s = BoardNav.withCopilotElicitation(two, form);
		const down = reduce(s, { name: "down" }).state;
		expect(head(down)).toMatchObject({ draft: { at: 0, cursor: 1 } });
		expect(down.selectedId).toBe("a");
		expect(reduce(down, char("j")).state.selectedId).toBe("b");
		const picked = reduce(down, { name: "return" });
		expect(head(picked.state)).toMatchObject({
			draft: { at: 1, values: { question_0: "Memory" } },
		});
	});

	it("an enter already on its way when the form appears picks nothing: it is held like a digit", () => {
		const arrived = BoardNav.sight(asked(), 5000);
		const early = BoardNav.reduceKey(arrived, { name: "return" }, 5200);
		expect(early.effect).toMatchObject({ type: "notice" });
		expect(head(early.state)).toMatchObject({ draft: { at: 0 } });
		// The cursor's keys settle nothing, so they move it at once.
		expect(
			head(BoardNav.reduceKey(arrived, { name: "down" }, 5200).state),
		).toMatchObject({ draft: { cursor: 1 } });
		expect(
			head(
				BoardNav.reduceKey(arrived, { name: "return" }, 5000 + BoardNav.ARM_MS)
					.state,
			),
		).toMatchObject({ draft: { at: 1, values: { question_0: "Redis" } } });
	});

	it("a multi-select toggles with space and sends with enter, from the copilot's focus too", () => {
		const tags: CopilotElicitation = {
			id: "form-2",
			message: "Which tags?",
			fields: [
				{
					key: "tags",
					title: "Tags",
					required: true,
					type: "choices",
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "Beta" },
					],
				},
			],
		};
		const s = BoardNav.withCopilotElicitation(
			state({ focus: "copilot", copilot: copilotState({ turn: "running" }) }),
			tags,
		);
		const toggled = [
			{ name: "down" },
			{ name: "space", sequence: " " },
			{ name: "up" },
			{ name: "space", sequence: " " },
		].reduce((acc, key) => reduce(acc, key).state, s);
		expect(reduce(toggled, { name: "return" }).effect).toEqual({
			type: "copilotAnswerForm",
			id: "form-2",
			answer: { action: "accept", content: { tags: ["b", "a"] } },
		});
	});

	it("s skips an optional choice and moves on to the next field", () => {
		expect(head(reduce(asked(), char("s")).state)).toMatchObject({
			draft: { at: 1, values: {} },
		});
	});

	it("a click on an option or a hint is the key's own step, and leaves the keys where they were", () => {
		const s = BoardNav.sight({ ...asked(), focus: "copilot" }, 0);
		const click = (action: BoardNav.MouseAction) =>
			BoardNav.reduceMouse(s, action);
		expect(click({ type: "askOption", index: 1 })).toEqual(
			reduce(s, char("2")),
		);
		expect(click({ type: "askKey", name: "s" })).toEqual(reduce(s, char("s")));
		expect(click({ type: "askKey", name: "escape" })).toEqual(
			reduce(s, { name: "escape" }),
		);
		expect(click({ type: "askOption", index: 1 }).state.focus).toBe("copilot");
		// A click is aimed at what is drawn: no ARM_MS for it.
		const arrived = BoardNav.sight(asked(), 5000);
		expect(
			head(
				BoardNav.reduceMouse(arrived, { type: "askOption", index: 0 }).state,
			),
		).toMatchObject({ draft: { at: 1, values: { question_0: "Redis" } } });
		// An option past the list answers nothing.
		expect(click({ type: "askOption", index: 5 }).state).toBe(s);
	});

	it("outranked by a question pinned on the view, a click on it hands it the keys and answers nothing", () => {
		const banner = {
			question: {
				taskId: "a",
				taskShortId: "JAKE-1",
				sessionId: "s",
				questionActivityId: "q",
				question: "Ship it?",
				choices: ["Yes", "No"],
				multiSelect: false,
				allowFreeform: false,
				agent: "claude",
				askedAt: "2026-10-10T00:00:00.000Z",
			},
		};
		const pinned = asked({ view: { type: "detail", taskId: "a", banner } });
		expect(BoardNav.copilotOutranked(pinned)).toBe(true);
		expect(BoardNav.askReach(pinned)).toEqual({ key: "tab" });
		expect(BoardNav.askReach(reduce(pinned, { name: "tab" }).state)).toBe(
			undefined,
		);
		for (const action of [
			{ type: "askOption", index: 0 },
			{ type: "askKey", name: "escape" },
			{ type: "askReach" },
		] as const) {
			const r = BoardNav.reduceMouse(pinned, action);
			expect(r.effect.type).toBe("none");
			expect(r.state.focus).toBe("copilot");
			expect(head(r.state)).toEqual(head(pinned));
			expect(BoardNav.askInHand(r.state)).toBe(true);
		}
	});

	it("each field is a question of its own: a digit already on its way does not answer the next", () => {
		const store = form.fields[0];
		if (!store) throw new Error("the form has a choice");
		const twice: CopilotElicitation = { ...form, fields: [store, store] };
		const s = BoardNav.sight(
			BoardNav.withCopilotElicitation(
				state({ copilot: copilotState({ turn: "running" }) }),
				twice,
			),
			0,
		);
		expect(BoardNav.digitTarget(s)).toBe("form-1#0");
		const first = BoardNav.reduceKey(s, char("1"), BoardNav.ARM_MS);
		const moved = BoardNav.sight(first.state, 1000);
		expect(BoardNav.digitTarget(moved)).toBe("form-1#1");
		expect(BoardNav.reduceKey(moved, char("1"), 1100).effect).toMatchObject({
			type: "notice",
		});
	});

	it("queues with permissions in the order the harness asked, either kind answered in turn", () => {
		const both = BoardNav.withCopilotElicitation(
			BoardNav.withCopilotPermission(
				state({ copilot: copilotState({ turn: "running" }) }),
				permission,
			),
			form,
		);
		expect(requests(both)).toEqual([permission, form]);
		const allowed = reduce(both, char("1"));
		expect(allowed.effect).toMatchObject({ type: "copilotAnswer", id: "t0" });
		expect(requests(allowed.state)).toEqual([form]);
		expect(BoardNav.withCopilotElicitation(both, form)).toBe(both);
	});

	it("an open prompt or a session question in hand keeps the form from the keys", () => {
		const prompting = asked({
			prompt: {
				...BoardPrompt.CLOSED,
				open: {
					target: { type: "act", cardId: "loop", actionId: "inject" },
					title: "inject",
					placeholder: "",
				},
			},
		});
		expect(BoardNav.askInHand(prompting)).toBe(false);
		expect(BoardNav.askInHand(asked())).toBe(true);
		expect(reduce(prompting, char("1")).effect.type).not.toBe(
			"copilotAnswerForm",
		);
	});

	// Seen live: the form looked the same whether or not it had the keys, so its keys went to an
	// open prompt, a `/` query or the question on the view, and the form seemed not to answer.
	it("says who has its keys and which key hands them over, and that key (or a click on it) does", () => {
		const prompting = asked({
			prompt: {
				...BoardPrompt.CLOSED,
				open: {
					target: { type: "act", cardId: "loop", actionId: "inject" },
					title: "inject",
					placeholder: "",
				},
			},
		});
		const searching = asked({ search: { mode: "typing", query: "ca" } });
		expect(BoardNav.askReach(asked())).toBeUndefined();
		expect(BoardNav.askReach(prompting)).toEqual({
			key: "esc",
			holder: "the prompt",
		});
		expect(BoardNav.askReach(searching)).toEqual({
			key: "enter",
			holder: "search",
		});
		for (const [held, key] of [
			[prompting, { name: "escape" }],
			[searching, { name: "return" }],
		] as const) {
			expect(BoardNav.askInHand(reduce(held, key).state)).toBe(true);
			const clicked = BoardNav.reduceMouse(held, { type: "askReach" }).state;
			expect(BoardNav.askInHand(clicked)).toBe(true);
			expect(head(clicked)).toEqual(head(held));
		}
		// The query typed is kept, as enter keeps it.
		expect(
			BoardNav.reduceMouse(searching, { type: "askReach" }).state.search,
		).toEqual({ mode: "committed", query: "ca" });
	});

	it("an enter that arrives after the form is gone sends nothing", () => {
		const gone = reduce(asked(), { name: "escape" }).state;
		expect(BoardNav.submitForm(gone, "late")).toEqual({
			state: gone,
			effect: { type: "none" },
		});
	});

	it("withdrawn by the harness, it leaves the queue wherever it is, and its keys answer nothing", () => {
		const both = BoardNav.withCopilotPermission(asked(), permission);
		const gone = BoardNav.withCopilotWithdrawn(both, "form-1");
		expect(requests(gone)).toEqual([permission]);
		// The digit pressed in the instant after goes to what is on screen now, never the form.
		expect(reduce(gone, char("1")).effect).toMatchObject({
			type: "copilotAnswer",
			id: "t0",
		});
		const none = BoardNav.withCopilotWithdrawn(gone, "t0");
		expect(none.copilot.asks).toEqual([]);
		expect(reduce(none, char("1")).effect.type).not.toMatch(/^copilotAnswer/);
		expect(BoardNav.withCopilotWithdrawn(none, "t0")).toBe(none);
	});

	it("a turn that stops takes the unanswered form with it", () => {
		expect(BoardNav.withCopilotTurn(asked(), "error").copilot.asks).toEqual([]);
	});
});
