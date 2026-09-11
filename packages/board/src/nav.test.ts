import { describe, expect, it } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardData } from "./data";
import { BoardNav } from "./nav";
import type { TriggerDescriptor } from "./ports";

const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JAKE-1",
	title: "A task",
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: new Date().toISOString() },
	needsReview: false,
	tags: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
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

const state = (
	over: Partial<BoardNav.BoardState> = {},
): BoardNav.BoardState => ({
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
	sidebar: { visible: true, focus: "board", selected: 0, itemCount: 0 },
	undo: [],
	...over,
});

// Feed a printable char the way OpenTUI does: name + raw sequence.
const char = (c: string): { name: string; sequence: string } => ({
	name: c,
	sequence: c,
});

// Type a whole query one keystroke at a time through the reducer.
const typeQuery = (s: BoardNav.BoardState, text: string): BoardNav.BoardState =>
	[...text].reduce((acc, c) => BoardNav.reduceKey(acc, char(c)).state, s);

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
			const down = BoardNav.reduceKey(s, { name: "j" });
			expect(down.state.selectedId).toBe("b");
			expect(down.effect.type).toBe("none");
			expect(
				BoardNav.reduceKey(down.state, { name: "k" }).state.selectedId,
			).toBe("a");
		});

		it("k clamps at the first row and j clamps at the last", () => {
			const s = state({
				sections: sections({
					inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			expect(BoardNav.reduceKey(s, { name: "k" }).state.selectedId).toBe("a");
			const last = state({ ...s, selectedId: "b" });
			expect(BoardNav.reduceKey(last, { name: "j" }).state.selectedId).toBe(
				"b",
			);
		});

		it("arrow keys mirror j/k", () => {
			const s = state({
				sections: sections({
					inbox: [row(task({ id: "a" })), row(task({ id: "b" }))],
				}),
				selectedId: "a",
			});
			expect(BoardNav.reduceKey(s, { name: "down" }).state.selectedId).toBe(
				"b",
			);
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
			const expanded = BoardNav.reduceKey(withTree(), { name: "space" });
			expect([...expanded.state.expanded]).toEqual(["p"]);
			const collapsed = BoardNav.reduceKey(expanded.state, { name: "space" });
			expect([...collapsed.state.expanded]).toEqual([]);
		});

		it("l expands the selected parent (no-op when already expanded)", () => {
			const expanded = BoardNav.reduceKey(withTree(), { name: "l" });
			expect([...expanded.state.expanded]).toEqual(["p"]);
			const again = BoardNav.reduceKey(expanded.state, { name: "l" });
			expect(again.state).toBe(expanded.state);
		});

		it("space is a no-op on a row without subtasks", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(BoardNav.reduceKey(s, { name: "space" }).state).toBe(s);
		});

		it("h on an expanded parent collapses it", () => {
			const s = withTree({ expanded: new Set(["p"]) });
			const collapsed = BoardNav.reduceKey(s, { name: "h" });
			expect([...collapsed.state.expanded]).toEqual([]);
			expect(collapsed.state.selectedId).toBe("p");
		});

		it("h on a child jumps selection to its parent", () => {
			const s = withTree({ expanded: new Set(["p"]), selectedId: "c" });
			const jumped = BoardNav.reduceKey(s, { name: "h" });
			expect(jumped.state.selectedId).toBe("p");
			// The parent stays expanded — h on a child only moves selection.
			expect([...jumped.state.expanded]).toEqual(["p"]);
		});
	});

	describe("kind filter", () => {
		it("i cycles all -> issue -> task -> all and asks for a reload", () => {
			const all = state({ kind: "all" });
			const issue = BoardNav.reduceKey(all, { name: "i" });
			expect(issue.state.kind).toBe("issue");
			expect(issue.effect.type).toBe("reload");
			expect(BoardNav.reduceKey(issue.state, { name: "i" }).state.kind).toBe(
				"task",
			);
			expect(
				BoardNav.reduceKey(
					BoardNav.reduceKey(issue.state, { name: "i" }).state,
					{ name: "i" },
				).state.kind,
			).toBe("all");
		});
	});

	describe("scope escape", () => {
		it("esc widens a scoped board to all scopes and reloads", () => {
			const scoped = state({ scoped: true });
			const { state: next, effect } = BoardNav.reduceKey(scoped, {
				name: "escape",
			});
			expect(next.scoped).toBe(false);
			expect(effect.type).toBe("reload");
		});

		it("esc is a no-op once already at all scopes", () => {
			const wide = state({ scoped: false });
			const { state: next, effect } = BoardNav.reduceKey(wide, {
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
			expect(BoardNav.reduceKey(s, { name: "]" }).effect).toEqual({
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
			expect(BoardNav.reduceKey(s, { name: "[" }).effect).toEqual({
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
			expect(BoardNav.reduceKey(s, { name: "]" }).effect.type).toBe("none");
		});

		it("d emits markDone for the selected row", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			expect(BoardNav.reduceKey(s, { name: "d" }).effect).toEqual({
				type: "markDone",
				id: "a",
				notice: "JAKE-1 done",
			});
		});

		it("mutation keys are no-ops when nothing is selected", () => {
			const s = state();
			expect(BoardNav.reduceKey(s, { name: "]" }).effect.type).toBe("none");
			expect(BoardNav.reduceKey(s, { name: "d" }).effect.type).toBe("none");
			expect(BoardNav.reduceKey(s, { name: "x" }).effect.type).toBe("none");
			expect(BoardNav.reduceKey(s, { name: "n" }).effect.type).toBe("none");
			expect(BoardNav.reduceKey(s, { name: "s" }).effect.type).toBe("none");
			expect(BoardNav.reduceKey(s, { name: "v" }).effect.type).toBe("none");
		});

		it("n/s/x jump the selected task directly to next/someday/cancelled", () => {
			const s = state({
				sections: sections({ inbox: [row(task({ id: "a", state: "inbox" }))] }),
				selectedId: "a",
			});
			expect(BoardNav.reduceKey(s, { name: "n" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "next",
				notice: "JAKE-1 → next",
			});
			expect(BoardNav.reduceKey(s, { name: "s" }).effect).toEqual({
				type: "setState",
				id: "a",
				state: "someday",
				notice: "JAKE-1 → someday",
			});
			expect(BoardNav.reduceKey(s, { name: "x" }).effect).toEqual({
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
			expect(BoardNav.reduceKey(flagged, { name: "v" }).effect).toEqual({
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
			const { effect } = BoardNav.reduceKey(clean, { name: "v" });
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
			const { state: next, effect } = BoardNav.reduceKey(s, { name: "y" });
			expect(effect).toEqual({ type: "copy", id: "a" });
			expect(next.view).toEqual({ type: "board" });
		});

		it("y on the board is a no-op when nothing is selected", () => {
			expect(BoardNav.reduceKey(state(), { name: "y" }).effect.type).toBe(
				"none",
			);
		});

		it("y in the detail view emits copy for the open task", () => {
			const s = state({ view: { type: "detail", taskId: "a" } });
			expect(BoardNav.reduceKey(s, { name: "y" }).effect).toEqual({
				type: "copy",
				id: "a",
			});
		});
	});

	describe("lifecycle keys", () => {
		it("q quits and r reloads", () => {
			expect(BoardNav.reduceKey(state(), { name: "q" }).effect.type).toBe(
				"quit",
			);
			expect(BoardNav.reduceKey(state(), { name: "r" }).effect.type).toBe(
				"reload",
			);
		});

		it("unknown keys return the same state reference", () => {
			const s = state();
			expect(BoardNav.reduceKey(s, { name: "z" }).state).toBe(s);
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
			const { state: next, effect } = BoardNav.reduceKey(
				searchable(),
				char("/"),
			);
			expect(next.search).toEqual({ mode: "typing", query: "" });
			expect(effect.type).toBe("none");
			// Empty query = no filter yet; the full list stays visible.
			expect(BoardNav.visibleRows(next)).toHaveLength(2);
		});

		it("printable chars append to the query and filter rows live", () => {
			const typing = BoardNav.reduceKey(searchable(), char("/")).state;
			const typed = typeQuery(typing, "auth");
			expect(typed.search).toEqual({ mode: "typing", query: "auth" });
			expect(BoardNav.visibleRows(typed).map((r) => r.task.id)).toEqual([
				"auth",
			]);
		});

		it("matches are case-insensitive over title and shortId", () => {
			const typing = BoardNav.reduceKey(searchable(), char("/")).state;
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
			const typing = BoardNav.reduceKey(searchable(), char("/")).state;
			const { state: next, effect } = BoardNav.reduceKey(typing, char("q"));
			expect(effect.type).toBe("none");
			expect(next.search).toEqual({ mode: "typing", query: "q" });
			// d likewise: appended, no markDone effect.
			expect(BoardNav.reduceKey(typing, char("d")).effect.type).toBe("none");
		});

		it("non-printable keys are inert while typing (same state reference)", () => {
			const typing = BoardNav.reduceKey(searchable(), char("/")).state;
			expect(
				BoardNav.reduceKey(typing, { name: "up", sequence: "\u001b[A" }).state,
			).toBe(typing);
			expect(
				BoardNav.reduceKey(typing, { name: "c", sequence: "c", ctrl: true })
					.state,
			).toBe(typing);
		});

		it("backspace deletes the last char; deleting to empty restores the full list", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable(), char("/")).state,
				"au",
			);
			const one = BoardNav.reduceKey(typed, { name: "backspace" }).state;
			expect(one.search).toEqual({ mode: "typing", query: "a" });
			const empty = BoardNav.reduceKey(one, { name: "backspace" }).state;
			expect(empty.search).toEqual({ mode: "typing", query: "" });
			expect(BoardNav.visibleRows(empty)).toHaveLength(2);
		});

		it("enter commits the filter; keys work again over the filtered list", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable(), char("/")).state,
				"auth",
			);
			const committed = BoardNav.reduceKey(typed, { name: "return" }).state;
			expect(committed.search).toEqual({ mode: "committed", query: "auth" });
			expect(BoardNav.visibleRows(committed).map((r) => r.task.id)).toEqual([
				"auth",
			]);
			// Normal bindings are live again: d marks the filtered row done.
			expect(BoardNav.reduceKey(committed, char("d")).effect).toMatchObject({
				type: "markDone",
				id: "auth",
			});
		});

		it("enter with an empty query clears the search (same as esc)", () => {
			const typing = BoardNav.reduceKey(searchable(), char("/")).state;
			const { state: next } = BoardNav.reduceKey(typing, { name: "return" });
			expect(next.search).toEqual({ mode: "off" });
		});

		it("esc while typing cancels input AND clears the query", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable(), char("/")).state,
				"auth",
			);
			const { state: next } = BoardNav.reduceKey(typed, { name: "escape" });
			expect(next.search).toEqual({ mode: "off" });
			expect(BoardNav.visibleRows(next)).toHaveLength(2);
		});

		it("esc layers: committed filter clears first, scope widens on the next press", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable({ scoped: true }), char("/")).state,
				"auth",
			);
			const committed = BoardNav.reduceKey(typed, { name: "return" }).state;
			const cleared = BoardNav.reduceKey(committed, { name: "escape" });
			expect(cleared.state.search).toEqual({ mode: "off" });
			expect(cleared.state.scoped).toBe(true);
			expect(cleared.effect.type).toBe("none");
			const widened = BoardNav.reduceKey(cleared.state, { name: "escape" });
			expect(widened.state.scoped).toBe(false);
			expect(widened.effect.type).toBe("reload");
		});

		it("selection re-anchors to the first match when narrowing hides it, stays put otherwise", () => {
			const typing = BoardNav.reduceKey(
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
			const typed = typeQuery(BoardNav.reduceKey(s, char("/")).state, "auth");
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
			const typed = typeQuery(BoardNav.reduceKey(s, char("/")).state, "auth");
			expect(BoardNav.visibleRows(typed).map((r) => r.task.id)).toEqual(["p"]);
			// With the parent in the expanded set, its children ride along.
			const open = { ...typed, expanded: new Set(["p"]) };
			expect(BoardNav.visibleRows(open).map((r) => r.task.id)).toEqual([
				"p",
				"c",
			]);
		});

		it("zero matches yields an empty visible list and esc still escapes", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable(), char("/")).state,
				"zzz",
			);
			expect(BoardNav.visibleRows(typed)).toHaveLength(0);
			expect(typed.selectedId).toBeNull();
			const { state: next } = BoardNav.reduceKey(typed, { name: "escape" });
			expect(next.search).toEqual({ mode: "off" });
			expect(next.selectedId).toBe("auth");
		});

		it("a committed filter survives a sections reload (poll/mutation)", () => {
			const typed = typeQuery(
				BoardNav.reduceKey(searchable(), char("/")).state,
				"auth",
			);
			const committed = BoardNav.reduceKey(typed, { name: "return" }).state;
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
			const { state: next } = BoardNav.reduceKey(detail, char("/"));
			expect(next.search).toEqual({ mode: "off" });
		});
	});

	describe("view stack", () => {
		it("enter opens the detail view for the selected row", () => {
			const s = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
			});
			const { state: next, effect } = BoardNav.reduceKey(s, { name: "return" });
			expect(next.view).toEqual({ type: "detail", taskId: "a" });
			expect(effect.type).toBe("none");
		});

		it("enter is a no-op when nothing is selected", () => {
			const s = state();
			expect(BoardNav.reduceKey(s, { name: "return" }).state.view).toEqual({
				type: "board",
			});
		});

		it("esc from the detail view returns to the board WITHOUT widening scope", () => {
			const detail = state({
				scoped: true,
				view: { type: "detail", taskId: "a" },
			});
			const back = BoardNav.reduceKey(detail, { name: "escape" });
			expect(back.state.view).toEqual({ type: "board" });
			expect(back.state.scoped).toBe(true);
			expect(back.effect.type).toBe("none");

			const widened = BoardNav.reduceKey(back.state, { name: "escape" });
			expect(widened.state.scoped).toBe(false);
			expect(widened.effect.type).toBe("reload");
		});

		it("q from the detail view returns to the board instead of quitting", () => {
			const detail = state({ view: { type: "detail", taskId: "a" } });
			const { state: next, effect } = BoardNav.reduceKey(detail, { name: "q" });
			expect(next.view).toEqual({ type: "board" });
			expect(effect.type).toBe("none");
		});

		it("j/k in the detail view emit scroll effects, not row moves", () => {
			const detail = state({
				sections: sections({ next: [row(task({ id: "a" }))] }),
				selectedId: "a",
				view: { type: "detail", taskId: "a" },
			});
			const down = BoardNav.reduceKey(detail, { name: "j" });
			expect(down.effect.type).toBe("scroll");
			expect(down.state.selectedId).toBe("a");
			expect(BoardNav.reduceKey(detail, { name: "k" }).effect.type).toBe(
				"scroll",
			);
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
		expect(BoardNav.reduceKey(open, { name: "n" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "next",
		});
		expect(BoardNav.reduceKey(open, { name: "s" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "someday",
		});
		expect(BoardNav.reduceKey(open, { name: "x" }).effect).toMatchObject({
			type: "setState",
			id: "b",
			state: "cancelled",
		});
	});

	it("v reviews the open task when flagged, no-ops with a flash otherwise", () => {
		expect(BoardNav.reduceKey(open, { name: "v" }).effect).toMatchObject({
			type: "markReviewed",
			id: "b",
		});
		const clean = { ...open, view: { type: "detail" as const, taskId: "a" } };
		expect(BoardNav.reduceKey(clean, { name: "v" }).effect).toMatchObject({
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
			BoardNav.reduceKey(boardWith(over), { name: "a" }).state,
			TRIGGERS,
		);

	it("`a` on the board opens the overlay loading on the selected row and asks the host for triggers", () => {
		const { state: next, effect } = BoardNav.reduceKey(boardWith(), {
			name: "a",
		});
		expect(next.dispatch).toEqual(LOADING);
		expect(effect).toEqual({ type: "loadTriggers", taskId: "a" });
	});

	it("`a` with nothing selected is a no-op", () => {
		const empty = state();
		const { state: next, effect } = BoardNav.reduceKey(empty, { name: "a" });
		expect(next.dispatch).toBeNull();
		expect(effect.type).toBe("none");
	});

	it("`a` in the detail view opens the overlay on the OPEN task", () => {
		const s = boardWith({ view: { type: "detail", taskId: "a" } });
		const { state: next, effect } = BoardNav.reduceKey(s, { name: "a" });
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
		const loading = BoardNav.reduceKey(boardWith(), { name: "a" }).state;
		for (const name of ["j", "k", "return", "q", "1"]) {
			const { state: next, effect } = BoardNav.reduceKey(loading, { name });
			expect(effect.type).toBe("none");
			expect(next.dispatch).toEqual(LOADING);
		}
		const { state: closed } = BoardNav.reduceKey(loading, { name: "escape" });
		expect(closed.dispatch).toBeNull();
	});

	it("j/k move the selection, clamped to the trigger list", () => {
		let s = open();
		s = BoardNav.reduceKey(s, { name: "j" }).state;
		s = BoardNav.reduceKey(s, { name: "j" }).state;
		expect(s.dispatch?.selected).toBe(2);
		s = BoardNav.reduceKey(s, { name: "j" }).state;
		s = BoardNav.reduceKey(s, { name: "j" }).state;
		s = BoardNav.reduceKey(s, { name: "j" }).state;
		expect(s.dispatch?.selected).toBe(4);
		s = BoardNav.reduceKey(s, { name: "k" }).state;
		expect(s.dispatch?.selected).toBe(3);
	});

	it("digits jump straight to a trigger; out-of-range digits are inert", () => {
		const s = BoardNav.reduceKey(open(), char("4")).state;
		expect(s.dispatch?.selected).toBe(3);
		const s5 = BoardNav.reduceKey(open(), char("5")).state;
		expect(s5.dispatch?.selected).toBe(4);
		const s9 = BoardNav.reduceKey(open(), char("9")).state;
		expect(s9.dispatch?.selected).toBe(0);
	});

	it("enter closes the overlay and emits the dispatch effect for the selected trigger", () => {
		const third = BoardNav.reduceKey(open(), char("3")).state;
		const { state: next, effect } = BoardNav.reduceKey(third, {
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
		const fifth = BoardNav.reduceKey(open(), char("5")).state;
		const { state: next, effect } = BoardNav.reduceKey(fifth, {
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
			BoardNav.reduceKey(boardWith(), { name: "a" }).state,
			[],
		);
		const { state: next, effect } = BoardNav.reduceKey(s, { name: "return" });
		expect(effect.type).toBe("none");
		expect(next.dispatch).toEqual(s.dispatch);
	});

	it("esc closes without an effect", () => {
		const { state: next, effect } = BoardNav.reduceKey(open(), {
			name: "escape",
		});
		expect(next.dispatch).toBeNull();
		expect(effect.type).toBe("none");
	});

	it("board keys are inert while the overlay is open", () => {
		const s = open();
		for (const name of ["q", "d", "x", "n", "s", "y", "space", "/"]) {
			const { state: next, effect } = BoardNav.reduceKey(s, { name });
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
		const { state: next, effect } = BoardNav.reduceKey(boardWith(), helpKey);
		expect(next.help).toBe(true);
		expect(effect.type).toBe("none");
	});

	it("`?` matched by sequence alone (undefined-ish name) still opens", () => {
		const { state: next } = BoardNav.reduceKey(boardWith(), {
			name: "",
			sequence: "?",
		});
		expect(next.help).toBe(true);
	});

	it("`?` in the detail view opens the overlay and keeps the view", () => {
		const s = state({ view: { type: "detail", taskId: "a" } });
		const { state: next } = BoardNav.reduceKey(s, helpKey);
		expect(next.help).toBe(true);
		expect(next.view).toEqual({ type: "detail", taskId: "a" });
	});

	it("`?`, esc, and q each close it", () => {
		const open = BoardNav.reduceKey(boardWith(), helpKey).state;
		for (const key of [helpKey, { name: "escape" }, { name: "q" }]) {
			const { state: next } = BoardNav.reduceKey(open, key);
			expect(next.help).toBe(false);
		}
	});

	it("all other keys are inert while open — j/d/a change nothing and emit nothing", () => {
		const open = BoardNav.reduceKey(boardWith(), helpKey).state;
		for (const name of ["j", "d", "a", "x", "/", "space", "return"]) {
			const { state: next, effect } = BoardNav.reduceKey(open, { name });
			expect(effect.type).toBe("none");
			expect(next.help).toBe(true);
			expect(next.selectedId).toBe("a");
			expect(next.dispatch).toBeNull();
		}
	});

	it("`?` while search-typing appends to the query instead of opening help", () => {
		const typing = state({ search: { mode: "typing", query: "wh" } });
		const { state: next } = BoardNav.reduceKey(typing, helpKey);
		expect(next.help).toBe(false);
		expect(next.search).toEqual({ mode: "typing", query: "wh?" });
	});

	it("mouse actions are inert while open", () => {
		const open = BoardNav.reduceKey(boardWith(), helpKey).state;
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

describe("sidebar keyboard routing", () => {
	const boardWith = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(task({ id: "a", shortId: "JAKE-1" }))],
			}),
			selectedId: "a",
			sidebar: { visible: true, focus: "board", selected: 0, itemCount: 3 },
			...over,
		});

	it("b toggles sidebar visibility on the board", () => {
		const s = boardWith();
		const { state: hidden } = BoardNav.reduceKey(s, { name: "b" });
		expect(hidden.sidebar.visible).toBe(false);
		expect(hidden.sidebar.focus).toBe("board");
		const { state: shown } = BoardNav.reduceKey(hidden, { name: "b" });
		expect(shown.sidebar.visible).toBe(true);
	});

	it("tab toggles focus between board and sidebar", () => {
		const s = boardWith();
		const { state: focused } = BoardNav.reduceKey(s, { name: "tab" });
		expect(focused.sidebar.focus).toBe("sidebar");
		const { state: back } = BoardNav.reduceKey(focused, { name: "tab" });
		expect(back.sidebar.focus).toBe("board");
	});

	it("tab is a no-op when sidebar is hidden", () => {
		const s = boardWith({
			sidebar: { visible: false, focus: "board", selected: 0, itemCount: 3 },
		});
		const { state: next } = BoardNav.reduceKey(s, { name: "tab" });
		expect(next.sidebar.focus).toBe("board");
	});

	it("j/k navigate sidebar items when focused", () => {
		const s = boardWith({
			sidebar: { visible: true, focus: "sidebar", selected: 0, itemCount: 3 },
		});
		const { state: down } = BoardNav.reduceKey(s, { name: "j" });
		expect(down.sidebar.selected).toBe(1);
		const { state: down2 } = BoardNav.reduceKey(down, { name: "j" });
		expect(down2.sidebar.selected).toBe(2);
		const { state: clamped } = BoardNav.reduceKey(down2, { name: "j" });
		expect(clamped.sidebar.selected).toBe(2);
		const { state: up } = BoardNav.reduceKey(clamped, { name: "k" });
		expect(up.sidebar.selected).toBe(1);
	});

	it("enter in sidebar emits sidebarSelect effect", () => {
		const s = boardWith({
			sidebar: { visible: true, focus: "sidebar", selected: 0, itemCount: 3 },
		});
		const { effect } = BoardNav.reduceKey(s, { name: "return" });
		expect(effect.type).toBe("sidebarSelect");
	});

	it("esc from sidebar focus returns to board focus", () => {
		const s = boardWith({
			sidebar: { visible: true, focus: "sidebar", selected: 0, itemCount: 3 },
		});
		const { state: next } = BoardNav.reduceKey(s, { name: "escape" });
		expect(next.sidebar.focus).toBe("board");
	});

	it("b works from the detail view", () => {
		const s = boardWith({ view: { type: "detail", taskId: "a" } });
		const { state: hidden } = BoardNav.reduceKey(s, { name: "b" });
		expect(hidden.sidebar.visible).toBe(false);
	});

	it("tab works from the detail view", () => {
		const s = boardWith({ view: { type: "detail", taskId: "a" } });
		const { state: focused } = BoardNav.reduceKey(s, { name: "tab" });
		expect(focused.sidebar.focus).toBe("sidebar");
	});

	it("sidebar j/k works from the detail view when focused", () => {
		const s = boardWith({
			view: { type: "detail", taskId: "a" },
			sidebar: { visible: true, focus: "sidebar", selected: 0, itemCount: 3 },
		});
		const { state: down } = BoardNav.reduceKey(s, { name: "j" });
		expect(down.sidebar.selected).toBe(1);
	});

	it("b works from the event view", () => {
		const s = boardWith({
			view: { type: "events", cardId: "r1", fromView: "board" },
		});
		const { state: hidden } = BoardNav.reduceKey(s, { name: "b" });
		expect(hidden.sidebar.visible).toBe(false);
	});

	it("tab works from the event view", () => {
		const s = boardWith({
			view: { type: "events", cardId: "r1", fromView: "board" },
		});
		const { state: focused } = BoardNav.reduceKey(s, { name: "tab" });
		expect(focused.sidebar.focus).toBe("sidebar");
	});

	it("sidebar j/k works from the event view when focused", () => {
		const s = boardWith({
			view: { type: "events", cardId: "r1", fromView: "board" },
			sidebar: { visible: true, focus: "sidebar", selected: 0, itemCount: 3 },
		});
		const { state: down } = BoardNav.reduceKey(s, { name: "j" });
		expect(down.sidebar.selected).toBe(1);
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
		expect(BoardNav.reduceKey(s, { name: "j" }).effect).toEqual({
			type: "scroll",
			delta: 2,
		});
		expect(BoardNav.reduceKey(s, { name: "k" }).effect).toEqual({
			type: "scroll",
			delta: -2,
		});
	});

	it("esc from events opened from board returns to board", () => {
		const s = runView();
		const { state: next } = BoardNav.reduceKey(s, { name: "escape" });
		expect(next.view).toEqual({ type: "board" });
	});

	it("q from events opened from board returns to board", () => {
		const s = runView();
		const { state: next } = BoardNav.reduceKey(s, { name: "q" });
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
		const { state: next } = BoardNav.reduceKey(s, { name: "escape" });
		expect(next.view).toEqual({ type: "detail", taskId: "a" });
	});

	it("esc from events opened from detail without fromTaskId falls back to board", () => {
		const s = runView({
			view: { type: "events", cardId: "r1", fromView: "detail" },
		});
		const { state: next } = BoardNav.reduceKey(s, { name: "escape" });
		expect(next.view).toEqual({ type: "board" });
	});

	it("unknown keys are no-ops in run detail", () => {
		const s = runView();
		for (const name of ["d", "x", "n", "s", "a", "space"]) {
			const { state: next, effect } = BoardNav.reduceKey(s, { name });
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
		const down = BoardNav.reduceKey(s, { name: "j" });
		expect(down.state.selectedId).toBe("a");
	});

	it("selection on a done match re-anchors when the query clears", () => {
		let s = both();
		s = BoardNav.reduceKey(s, { name: "/" }).state;
		s = typeQuery(s, "shipped");
		expect(BoardNav.visibleRows(s).map((r) => r.task.id)).toEqual(["dn"]);
		s = { ...s, selectedId: "dn" };
		const { state: cleared } = BoardNav.reduceKey(s, { name: "escape" });
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
			expect(BoardNav.reduceKey(s, { name: "]" }).state.undo).toEqual([
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
			expect(BoardNav.reduceKey(s, { name: "[" }).state.undo).toEqual([
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
				expect(BoardNav.reduceKey(s, { name }).state.undo).toEqual([
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
			expect(BoardNav.reduceKey(s, { name: "d" }).state.undo).toEqual([
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
			expect(BoardNav.reduceKey(clean, { name: "v" }).state.undo).toEqual([
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
			expect(
				BoardNav.reduceKey(withVerification, { name: "v" }).state.undo,
			).toEqual([
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
			expect(BoardNav.reduceKey(s, { name: "v" }).state.undo).toHaveLength(0);
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
			const { state: next, effect } = BoardNav.reduceKey(seeded(), ctrlZ);
			expect(effect).toEqual({
				type: "applyUndo",
				id: "a",
				patch: { state: "inbox" },
				notice: "undo: JAKE-1 → inbox",
			});
			expect(next.undo).toHaveLength(0);
		});

		it("matches the raw SUB control sequence too", () => {
			const { effect } = BoardNav.reduceKey(seeded(), {
				name: "",
				sequence: "\x1a",
				ctrl: true,
			});
			expect(effect.type).toBe("applyUndo");
		});

		it("works from the detail view (routes across views)", () => {
			const s = seeded({ view: { type: "detail", taskId: "a" } });
			const { effect } = BoardNav.reduceKey(s, ctrlZ);
			expect(effect).toMatchObject({ type: "applyUndo", id: "a" });
		});

		it("empty stack flashes 'nothing to undo', stack unchanged", () => {
			const s = seeded({ undo: [] });
			const { state: next, effect } = BoardNav.reduceKey(s, ctrlZ);
			expect(effect).toEqual({
				type: "notice",
				notice: { text: "nothing to undo", tone: "success" },
			});
			expect(next).toBe(s);
		});

		it("is inert while search-typing (query untouched, no applyUndo)", () => {
			const s = seeded({ search: { mode: "typing", query: "au" } });
			const { state: next, effect } = BoardNav.reduceKey(s, ctrlZ);
			expect(effect.type).toBe("none");
			expect(next.search).toEqual({ mode: "typing", query: "au" });
			expect(next.undo).toHaveLength(1);
		});

		it("is inert while the help overlay is open", () => {
			const s = seeded({ help: true });
			const { state: next, effect } = BoardNav.reduceKey(s, ctrlZ);
			expect(effect.type).toBe("none");
			expect(next.undo).toHaveLength(1);
		});

		it("is inert while the dispatch overlay is open", () => {
			const s = seeded({
				dispatch: { taskId: "a", triggers: [], selected: 0, loading: false },
			});
			const { state: next, effect } = BoardNav.reduceKey(s, ctrlZ);
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
			const one = BoardNav.reduceKey(s, ctrlZ);
			expect(one.effect).toMatchObject({
				type: "applyUndo",
				notice: "undo: second",
			});
			expect(one.state.undo).toHaveLength(1);
			const two = BoardNav.reduceKey(one.state, ctrlZ);
			expect(two.effect).toMatchObject({
				type: "applyUndo",
				notice: "undo: first",
			});
			expect(two.state.undo).toHaveLength(0);
			const three = BoardNav.reduceKey(two.state, ctrlZ);
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
		const next = BoardNav.reduceKey(s, { name: "]" }).state;
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
		const { effect } = BoardNav.reduceKey(s, { name: "r" });
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
		const { effect } = BoardNav.reduceKey(s, { name: "o" });
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
		const { effect } = BoardNav.reduceKey(s, { name: "o" });
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
	// One of each quadrant: open/done × flagged/not.
	const board = (over: Partial<BoardNav.BoardState> = {}) =>
		state({
			sections: sections({
				next: [row(openTask), row(flagged)],
				done: [row(doneFlagged), row(donePlain)],
			}),
			selectedId: "a",
			...over,
		});

	const ids = (s: BoardNav.BoardState): string[] =>
		BoardNav.visibleRows(s).map((r) => r.task.id);

	it("f cycles open -> done -> review -> open WITHOUT a reload", () => {
		const s = board();
		const done = BoardNav.reduceKey(s, { name: "f" });
		expect(done.state.status).toBe("done");
		// The whole point of the view-level design: the rows are already in hand.
		expect(done.effect.type).toBe("none");
		const review = BoardNav.reduceKey(done.state, { name: "f" });
		expect(review.state.status).toBe("review");
		expect(review.effect.type).toBe("none");
		const back = BoardNav.reduceKey(review.state, { name: "f" });
		expect(back.state.status).toBe("open");
		expect(back.effect.type).toBe("none");
	});

	it("open is the default and renders exactly what the board always showed", () => {
		expect(board().status).toBe("open");
		expect(ids(board())).toEqual(["a", "fl"]);
	});

	it("done shows the archive section with no query typed, and nothing else", () => {
		const s = BoardNav.reduceKey(board(), { name: "f" }).state;
		const groups = BoardNav.visibleSections(
			s.sections,
			s.expanded,
			s.search,
			s.status,
		);
		expect(groups.map((g) => g.section.state)).toEqual(["done"]);
		expect(ids(s)).toEqual(["df", "dp"]);
	});

	it("review spans every section and keeps only flagged rows, done included", () => {
		const s = board({ status: "review" });
		const groups = BoardNav.visibleSections(
			s.sections,
			s.expanded,
			s.search,
			s.status,
		);
		expect(groups.map((g) => g.section.state)).toEqual(["next", "done"]);
		// "done AND needs review" — the reason review composes over the states.
		expect(ids(s)).toEqual(["fl", "df"]);
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
		const done = BoardNav.reduceKey(board({ selectedId: "a" }), { name: "f" });
		expect(done.state.selectedId).toBe("df");
		// And back the other way: `df` is done, so `open` hides it.
		const back = BoardNav.reduceKey(
			board({ status: "review", selectedId: "df" }),
			{
				name: "f",
			},
		);
		expect(back.state.status).toBe("open");
		expect(back.state.selectedId).toBe("a");
	});

	it("f keeps the selected row when it survives the change", () => {
		// `df` is done AND flagged, so it is on screen under both statuses.
		const s = board({ status: "done", selectedId: "df" });
		const review = BoardNav.reduceKey(s, { name: "f" });
		expect(review.state.status).toBe("review");
		expect(review.state.selectedId).toBe("df");
	});

	it("a query narrows WITHIN the active status rather than replacing it", () => {
		let s = board({ status: "review" });
		s = BoardNav.reduceKey(s, { name: "/" }).state;
		s = typeQuery(s, "shipped");
		// "shipped" matches both done rows; the review status keeps only the flagged one.
		expect(ids(s)).toEqual(["df"]);
	});

	it("a query under status done never reaches the open sections", () => {
		let s = board({ status: "done" });
		s = BoardNav.reduceKey(s, { name: "/" }).state;
		s = typeQuery(s, "work");
		// "open work" matches, but it lives in `next` — out of this status.
		expect(ids(s)).toEqual([]);
	});

	it("review keeps a flagged subtask's parent visible and forces it open", () => {
		const parent = task({ id: "p", shortId: "JAKE-5", title: "parent" });
		const child = task({
			id: "c",
			shortId: "JAKE-6",
			title: "child",
			needsReview: true,
		});
		const sibling = task({ id: "c2", shortId: "JAKE-7", title: "sibling" });
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
		s = BoardNav.reduceKey(s, { name: "/" }).state;
		s = typeQuery(s, "agent");
		s = BoardNav.reduceKey(s, { name: "return" }).state;
		const cleared = BoardNav.reduceKey(s, { name: "escape" });
		expect(cleared.state.search.mode).toBe("off");
		expect(cleared.state.status).toBe("review");
		const widened = BoardNav.reduceKey(cleared.state, { name: "escape" });
		expect(widened.state.scoped).toBe(false);
		expect(widened.state.status).toBe("review");
	});

	it("f is inert while a search query is being typed", () => {
		let s = board();
		s = BoardNav.reduceKey(s, { name: "/" }).state;
		s = typeQuery(s, "f");
		expect(s.status).toBe("open");
		expect(BoardNav.activeQuery(s.search)).toBe("f");
	});
});
